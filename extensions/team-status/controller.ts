/**
 * Team 团队可视化 — 会话生命周期 controller（Task 8）。
 *
 * 唯一拥有 timer / writer/observer 状态机的模块：组合 store、reducer、两个
 * 事件适配器、TUI overlay 与 Web 投影。注册 Pi 生命周期与工具事件处理，
 * 并提供 `/team-panel show|hide|auto` 命令。
 *
 * 关键不变量（ruling）：
 * - 工厂注册零计时器；session_start 创建新 generation/当前会话并启动 1s 轮询；
 *   session_shutdown 使旧 generation 的事件/异步 tick 全部 no-op、清唯一 timer、
 *   dispose 适配器与 overlay、清空 status/widget、移除自身 shard。
 * - 单 1s tick 按序执行：refresh async（仅 writer）→ 剪枝本地 terminal 成员 →
 *   到期心跳/写 shard → 读当前 session shards → 聚合（last-good 回退）→ 投影。
 *   不允许重叠异步 tick。
 * - observer 在 /team 成功激活或本地 subagent/Agent start 后晋升 writer；
 *   writer 恒含一名 Leader；observer 仅因打开会话绝不写空/纯 leader shard。
 * - 心跳时间绝不回退：写 shard 前以 runtime.heartbeatAt clamp 当前时间。
 * - 每个 terminal 成员保留 terminalAt；controller 在 30s 后剪枝，绝不改写聚合成员。
 * - TUI 仅 setStatus + overlay manager；RPC 仅 setStatus/setWidget；auto 仅在有
 *   成员时显示，show 保持投影，hide 清空所有投影面。
 * - 诊断错误限频且绝不逃逸到事件/计时器处理外；读损坏时保留 last-good aggregate。
 */
import { randomUUID as nodeRandomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeamShardStore, type TeamShardStoreOptions } from "./store.ts";
import {
  activateLeader,
  aggregateRuntimeShards,
  createRuntimeState,
  toRuntimeShard,
  type TeamRuntimeState,
} from "./reducer.ts";
import {
  createPiSubagentsAdapter,
  type PiSubagentsAdapter,
} from "./pi-subagents-adapter.ts";
import { createPiWebAgentAdapter, type PiWebAgentAdapter } from "./pi-web-agent-adapter.ts";
import {
  createTuiOverlayManager,
  type TuiOverlayContext,
  type TuiOverlayManager,
} from "./tui-overlay.ts";
import {
  clearWebWidget,
  projectWebWidget,
  renderStatusSummary,
  WEB_WIDGET_KEY,
} from "./web-widget.ts";
import {
  ACTIVE_HEARTBEAT_MS,
  IDLE_HEARTBEAT_MS,
  OBSERVER_POLL_MS,
  TERMINAL_RETENTION_MS,
  type PanelMode,
  type TeamAggregateV1,
  type TeamMemberState,
  type TeamMemberStatusV1,
  type TeamRuntimeShardV1,
} from "./types.ts";

const DEFAULT_LEADER_TITLE = "Team";
const DIAGNOSTIC_MIN_INTERVAL_MS = 1000;

const TERMINAL_STATES: ReadonlySet<TeamMemberState> = new Set(["completed", "failed", "stopped"]);

// ---------- 依赖注入类型 ----------

export interface TimersLike {
  setInterval(handler: () => void, timeoutMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export type StoreFactory = (options: TeamShardStoreOptions) => TeamShardStore;

export interface TeamStatusControllerDeps {
  agentDir: string;
  now?: () => number;
  randomUUID?: () => string;
  timers?: TimersLike;
  storeFactory?: StoreFactory;
  onDiagnostic?: (message: string, error?: unknown) => void;
}

export interface TeamStatusControllerHandle {
  activateTeam(ctx: ExtensionContext, title?: string): void;
  dispose(): Promise<void>;
}

const defaultTimers: TimersLike = {
  setInterval: (handler, timeoutMs) => setInterval(handler, timeoutMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

// ---------- 辅助 ----------

function isTerminalState(state: TeamMemberState): boolean {
  return TERMINAL_STATES.has(state);
}

function hasActiveChild(runtime: TeamRuntimeState): boolean {
  for (const member of runtime.members.values()) {
    if (member.role === "leader") continue;
    if (!isTerminalState(member.state)) return true;
  }
  return false;
}

function pruneTerminal(runtime: TeamRuntimeState, nowMs: number): void {
  for (const [key, member] of runtime.members) {
    if (!isTerminalState(member.state)) continue;
    if (typeof member.terminalAt === "number" && nowMs - member.terminalAt > TERMINAL_RETENTION_MS) {
      runtime.members.delete(key);
    }
  }
}

function emptyAggregate(sessionId: string, generatedAt: number): TeamAggregateV1 {
  return { sessionId, generatedAt, members: [], liveShardCount: 0, staleShardCount: 0, omittedMembers: 0 };
}

/** 将随机 id 收敛为可移植 writer 文件名（白名单 [A-Za-z0-9._-]）。 */
function toPortableWriterId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "");
  return cleaned.length > 0 ? cleaned : "writer";
}

// ---------- 注册 ----------

export function registerTeamStatus(pi: ExtensionAPI, deps: TeamStatusControllerDeps): TeamStatusControllerHandle {
  const now = deps.now ?? (() => Date.now());
  const randomUUID = deps.randomUUID ?? nodeRandomUUID;
  const timers = deps.timers ?? defaultTimers;
  const storeFactory = deps.storeFactory ?? ((options) => new TeamShardStore(options));
  const onDiagnostic = deps.onDiagnostic ?? (() => {});

  const store = storeFactory({ agentDir: deps.agentDir, now, randomUUID });
  const writerId = toPortableWriterId(randomUUID());
  const writerPid = process.pid;

  // 生命周期状态（全部由本模块独占）。
  let generation = 0;
  let activeCtx: ExtensionContext | undefined;
  let currentSessionId: string | undefined;
  let runtime: TeamRuntimeState | undefined;
  let subagentsAdapter: PiSubagentsAdapter | undefined;
  let piWebAdapter: PiWebAgentAdapter | undefined;
  let overlayManager: TuiOverlayManager | undefined;
  let timerHandle: unknown;
  let timerActive = false;
  let ticking = false;
  let isWriter = false;
  let dirty = false;
  let nextWriteAt = 0;
  let panelMode: PanelMode = "auto";
  let lastAggregate: TeamAggregateV1 | undefined;
  let lastDiagnosticAt = 0;

  function reportDiagnostic(message: string, error?: unknown): void {
    const t = now();
    if (t - lastDiagnosticAt < DIAGNOSTIC_MIN_INTERVAL_MS) return;
    lastDiagnosticAt = t;
    try {
      onDiagnostic(message, error);
    } catch {
      // 诊断回调自身不得抛出。
    }
  }

  function guard(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      reportDiagnostic(label, error);
    }
  }

  async function guardAsync(label: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (error) {
      reportDiagnostic(label, error);
    }
  }

  function notify(ctx: ExtensionContext, message: string, kind: "info" | "error" = "info"): void {
    guard("notify", () => {
      if (ctx.hasUI) ctx.ui.notify(message, kind);
      else console.log(`[${kind}] ${message}`);
    });
  }

  function promoteToWriter(rt: TeamRuntimeState, title: string): void {
    isWriter = true;
    activateLeader(rt, { title, now: now() });
    dirty = true;
    nextWriteAt = 0;
  }

  function clearSurfaces(ctx: ExtensionContext): void {
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(WEB_WIDGET_KEY, undefined);
      overlayManager?.hide();
    } else if (ctx.mode === "rpc") {
      clearWebWidget(ctx);
    }
  }

  function applyProjection(ctx: ExtensionContext, aggregate: TeamAggregateV1, mode: PanelMode): void {
    if (mode === "hide") {
      clearSurfaces(ctx);
      return;
    }
    const enabled = mode === "show" || aggregate.members.length > 0;
    if (ctx.mode === "tui") {
      if (enabled) {
        ctx.ui.setStatus(WEB_WIDGET_KEY, renderStatusSummary(aggregate));
        const overlay = overlayManager;
        if (overlay) {
          overlay.show(ctx as unknown as TuiOverlayContext);
          overlay.refresh();
        }
      } else {
        ctx.ui.setStatus(WEB_WIDGET_KEY, undefined);
        overlayManager?.hide();
      }
    } else if (ctx.mode === "rpc") {
      projectWebWidget(ctx, aggregate, enabled);
    }
  }

  async function runTick(gen: number): Promise<void> {
    const ctx = activeCtx;
    const sid = currentSessionId;
    const rt = runtime;
    if (!ctx || !sid || !rt) return;

    const tickNow = now();

    // 1. refresh async adapter（仅 writer）。
    if (isWriter) {
      await guardAsync("subagents.refreshAsync", () => subagentsAdapter?.refreshAsync() ?? Promise.resolve());
    }
    if (generation !== gen) return;

    // 2. 剪枝本地 terminal 成员。
    pruneTerminal(rt, tickNow);

    // 3. 到期心跳 / 写 shard（心跳时间不回退）。
    if (isWriter) {
      const writeNow = Math.max(tickNow, rt.heartbeatAt);
      if (dirty || writeNow >= nextWriteAt) {
        try {
          await store.write(toRuntimeShard(rt, writeNow));
          dirty = false;
          nextWriteAt = writeNow + (hasActiveChild(rt) ? ACTIVE_HEARTBEAT_MS : IDLE_HEARTBEAT_MS);
        } catch (error) {
          reportDiagnostic("store.write", error);
        }
      }
    }
    if (generation !== gen) return;

    // 4. 读当前 session shards；损坏时保留 last-good aggregate。
    let shards: TeamRuntimeShardV1[];
    try {
      shards = await store.read(sid);
    } catch (error) {
      reportDiagnostic("store.read", error);
      return;
    }
    if (generation !== gen) return;

    // 5. 聚合（last-good 回退）。
    let aggregate: TeamAggregateV1;
    try {
      aggregate = aggregateRuntimeShards(shards, sid, tickNow);
    } catch (error) {
      reportDiagnostic("aggregate", error);
      return;
    }
    lastAggregate = aggregate;

    // 6. 投影。
    applyProjection(ctx, aggregate, panelMode);
  }

  async function tick(): Promise<void> {
    if (ticking || !timerActive) return;
    const gen = generation;
    ticking = true;
    try {
      await runTick(gen);
    } catch (error) {
      reportDiagnostic("tick", error);
    } finally {
      ticking = false;
    }
  }

  function startSession(ctx: ExtensionContext): Promise<void> {
    // 幂等地拆除上一代会话（重复 session_start 不得泄漏 timer/overlay/adapters），
    // 之后再分配新状态；绝不在新会话分配后拆除。
    return teardown().then(() => {
      generation += 1;
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();

      activeCtx = ctx;
      currentSessionId = sessionId;
      runtime = createRuntimeState({
        sessionId,
        sessionFile,
        writerId,
        writerPid,
        now: now(),
      });

      const rt = runtime;
      subagentsAdapter = createPiSubagentsAdapter({
        events: pi.events,
        runtime: rt,
        now,
        randomUUID,
        onChanged: () => {
          dirty = true;
        },
      });
      piWebAdapter = createPiWebAgentAdapter({
        runtime: rt,
        now,
        onChanged: () => {
          dirty = true;
        },
      });
      overlayManager = createTuiOverlayManager({
        getAggregate: () => lastAggregate ?? emptyAggregate(sessionId, now()),
        onError: (error) => reportDiagnostic("overlay", error),
      });

      isWriter = false;
      dirty = false;
      nextWriteAt = 0;
      panelMode = "auto";
      lastAggregate = undefined;

      timerHandle = timers.setInterval(() => tick(), OBSERVER_POLL_MS);
      timerActive = true;

      // 规格 §9.3：session_start 做一次有界 GC（fire-and-forget，失败仅诊断）。
      void guardAsync("store.gc", () => store.gc());
    });
  }

  async function teardown(ctx?: ExtensionContext): Promise<void> {
    generation += 1;
    const surfaceCtx = ctx ?? activeCtx;

    timerActive = false;
    if (timerHandle !== undefined) {
      timers.clearInterval(timerHandle);
      timerHandle = undefined;
    }

    if (surfaceCtx) clearSurfaces(surfaceCtx);
    overlayManager?.dispose();
    overlayManager = undefined;
    subagentsAdapter?.dispose();
    subagentsAdapter = undefined;
    piWebAdapter?.dispose();
    piWebAdapter = undefined;

    const rt = runtime;
    const sid = currentSessionId;
    runtime = undefined;
    currentSessionId = undefined;
    activeCtx = undefined;
    isWriter = false;
    dirty = false;
    nextWriteAt = 0;
    lastAggregate = undefined;

    // 移除自身 shard（幂等；observer 无 shard 时为无操作 unlink）。
    if (rt && sid) {
      await store.remove(sid, rt.writerId).catch(() => {});
    }
  }

  // ---------- 事件注册 ----------

  pi.on("session_start", (_event, ctx) => guardAsync("session_start", () => startSession(ctx)));

  pi.on("session_shutdown", (_event, ctx) => guardAsync("session_shutdown", () => teardown(ctx)));

  pi.on("tool_execution_start", (event) => {
    guard("tool_execution_start", () => {
      const rt = runtime;
      if (!rt) return;
      if (!isWriter) {
        const args = (event as { args?: { action?: unknown } }).args;
        const isAgentStart = event.toolName === "Agent";
        const isSubagentDispatch = event.toolName === "subagent" && args?.action === undefined;
        if (isAgentStart || isSubagentDispatch) {
          promoteToWriter(rt, DEFAULT_LEADER_TITLE);
        }
      }
      subagentsAdapter?.onToolStart(event);
      piWebAdapter?.onToolStart(event);
    });
  });

  pi.on("tool_execution_update", (event) => {
    guard("tool_execution_update", () => {
      if (!runtime) return;
      subagentsAdapter?.onToolUpdate(event);
      piWebAdapter?.onToolUpdate(event);
    });
  });

  pi.on("tool_execution_end", (event) => {
    guard("tool_execution_end", () => {
      if (!runtime) return;
      subagentsAdapter?.onToolEnd(event);
      piWebAdapter?.onToolEnd(event);
    });
  });

  pi.on("message_end", (event) => {
    guard("message_end", () => {
      if (!runtime) return;
      piWebAdapter?.onMessageEnd(event);
    });
  });

  pi.registerCommand("team-panel", {
    description: "控制团队可视化面板：show / hide / auto",
    handler: async (args, ctx) => {
      const value = (args ?? "").trim();
      if (value === "show" || value === "hide" || value === "auto") {
        panelMode = value;
        const aggregate = lastAggregate ?? emptyAggregate(currentSessionId ?? "", now());
        applyProjection(ctx, aggregate, panelMode);
        return;
      }
      notify(ctx, "用法: /team-panel show|hide|auto", "error");
    },
  });

  return {
    activateTeam(ctx, title) {
      const rt = runtime;
      if (!rt) return;
      promoteToWriter(rt, title ?? DEFAULT_LEADER_TITLE);
    },
    async dispose() {
      await teardown();
    },
  };
}
