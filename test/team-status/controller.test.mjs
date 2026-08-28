/**
 * Team 团队可视化 — 会话 controller 生命周期测试（Task 8）。
 *
 * 只使用 Pi ExtensionAPI 的公开结构契约（on / registerCommand / events），
 * 不 import pi-coding-agent 运行时。用假时钟/计时器、假 store（记录 read/write/
 * remove/gc 调用）与可控 EventBus 断言：工厂注册零计时器、session_start 每秒轮询、
 * session_shutdown 清空所有投影面、observer 晋升 writer、心跳节奏（active 2s /
 * leader-only 5s）、malformed read 保留 last-good aggregate、terminal 30s 剪枝、
 * shutdown 移除自身 shard、以及 /team-panel show|hide|auto 状态机。
 *
 * 本文件为纯 ESM（.mjs），不得使用 TS 语法；类型信息以 JSDoc typedef 记录。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerTeamStatus } from "../../extensions/team-status/controller.ts";
import {
  SUBAGENT_RPC_REQUEST_EVENT,
  SUBAGENT_RPC_REPLY_PREFIX,
} from "../../extensions/team-status/pi-subagents-adapter.ts";
import { NOW, SESSION_ID, member, shard } from "./fixtures.mjs";

const DEFAULT_LEADER_TITLE = "Team";
const TICK_MS = 1000;

// ---------- 工具事件夹具（与 pi-coding-agent ToolExecution*Event 结构一致） ----------

function toolStart(toolName, toolCallId, args) {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function toolUpdate(toolName, toolCallId, partialResult, args = {}) {
  return { type: "tool_execution_update", toolCallId, toolName, args, partialResult };
}

function toolEnd(toolName, toolCallId, result, isError = false) {
  return { type: "tool_execution_end", toolCallId, toolName, result, isError };
}

/** 前台子代理 running progress 夹具：一个 executor 活跃子成员。 */
function runningProgress() {
  return {
    runId: "foreground-run",
    mode: "parallel",
    progress: [{
      index: 1,
      agent: "executor",
      status: "running",
      task: "Implement reducer",
      currentTool: "bash",
      recentOutput: ["npm test"],
      recentTools: [],
      toolCount: 1,
      tokens: 1,
      durationMs: 1,
    }],
    results: [],
  };
}

/** 前台子代理 completed result 夹具：一个 executor 终态子成员。 */
function completedResult() {
  return {
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "parallel",
      runId: "run-done",
      results: [{ index: 0, agent: "executor", task: "Ok", exitCode: 0, usage: {} }],
    },
  };
}

// ---------- 可控假时钟 / 计时器 ----------

function makeClock(startAt = NOW) {
  let current = startAt;
  let nextId = 1;
  const timers = new Map();

  const now = () => current;

  function setInterval(fn, ms) {
    const id = nextId++;
    timers.set(id, { fn, ms, nextAt: current + ms });
    return id;
  }

  function clearInterval(id) {
    timers.delete(id);
  }

  /** 推进虚拟时间并依次触发到期计时器；每个回调的 Promise 被 await（等 tick 完整结束）。 */
  async function tickAsync(ms) {
    const target = current + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.nextAt <= target)
        .sort((a, b) => a[1].nextAt - b[1].nextAt);
      if (due.length === 0) break;
      const [, t] = due[0];
      current = t.nextAt;
      t.nextAt += t.ms;
      await t.fn();
    }
    current = target;
  }

  function activeTimerCount() {
    return timers.size;
  }

  return { now, setInterval, clearInterval, tickAsync, activeTimerCount };
}

// ---------- 可控假 EventBus（pi-subagents RPC 桥） ----------

function makeBus() {
  const listeners = new Map();
  const bus = {
    emit(channel, data) {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on(channel, handler) {
      const arr = listeners.get(channel) ?? [];
      arr.push(handler);
      listeners.set(channel, arr);
      return () => {
        const cur = listeners.get(channel) ?? [];
        const idx = cur.indexOf(handler);
        if (idx >= 0) cur.splice(idx, 1);
      };
    },
  };
  return bus;
}

/** 安装模拟 pi-subagents RPC 桥：收到 status 请求即回空包（refreshAsync 立即返回）。 */
function installStatusBridge(bus) {
  bus.on(SUBAGENT_RPC_REQUEST_EVENT, (req) => {
    bus.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${req.requestId}`, {
      version: 1,
      requestId: req.requestId,
      method: req.method,
      success: true,
      data: {},
    });
  });
}

// ---------- 假 store（记录调用，可控 shard / read 失败） ----------

function makeStore() {
  const readCalls = [];
  const writeCalls = [];
  const removeCalls = [];
  const gcCalls = [];
  const state = { shards: [], failNextRead: false };
  return {
    readCalls,
    writeCalls,
    removeCalls,
    gcCalls,
    state,
    async read(sessionId) {
      readCalls.push(sessionId);
      if (state.failNextRead) {
        state.failNextRead = false;
        throw new Error("simulated read corruption");
      }
      return [...state.shards];
    },
    async write(record) {
      writeCalls.push(record);
    },
    async remove(sessionId, writerId) {
      removeCalls.push([sessionId, writerId]);
    },
    async gc() {
      gcCalls.push(1);
    },
  };
}

// ---------- 假 UI 上下文（tui / rpc） ----------

function baseSessionManager() {
  return {
    getSessionId: () => SESSION_ID,
    getSessionFile: () => "fixture-session.json",
  };
}

/** RPC 上下文：记录 setStatus / setWidget / notify，并保留 custom 间谍以断言绝不调用。 */
function rpcContext() {
  const statusCalls = [];
  const widgetCalls = [];
  const customCalls = [];
  const notifyCalls = [];
  const ui = {
    setStatus(key, text) {
      statusCalls.push([key, text]);
    },
    setWidget(key, content, options) {
      widgetCalls.push([key, content, options]);
    },
    custom() {
      customCalls.push(1);
      return Promise.resolve(null);
    },
    notify(message, type) {
      notifyCalls.push([message, type]);
    },
  };
  return {
    mode: "rpc",
    hasUI: true,
    ui,
    sessionManager: baseSessionManager(),
    statusCalls,
    widgetCalls,
    customCalls,
    notifyCalls,
  };
}

/** TUI 上下文：模拟 ctx.ui.custom 语义（工厂同步执行 + onHandle 回调 + done 解析）。 */
function tuiContext() {
  const statusCalls = [];
  const widgetCalls = [];
  const customCalls = [];
  const doneValues = [];
  const notifyCalls = [];
  const ui = {
    setStatus(key, text) {
      statusCalls.push([key, text]);
    },
    setWidget(key, content, options) {
      widgetCalls.push([key, content, options]);
    },
    notify(message, type) {
      notifyCalls.push([message, type]);
    },
    custom(factory, options) {
      const call = { factory, options };
      customCalls.push(call);
      return new Promise((resolve) => {
        let closed = false;
        const done = (result) => {
          if (closed) return;
          closed = true;
          doneValues.push(result);
          resolve(result);
        };
        const tui = { requestRender() {} };
        const theme = { fg(_color, text) { return text; } };
        factory(tui, theme, {}, done);
        if (options?.overlay) {
          const handle = { unfocus() {}, hide() {} };
          options.onHandle?.(handle);
        }
      });
    },
  };
  return {
    mode: "tui",
    hasUI: true,
    ui,
    sessionManager: baseSessionManager(),
    statusCalls,
    widgetCalls,
    customCalls,
    doneValues,
    notifyCalls,
  };
}

// ---------- Pi API / 依赖组装 ----------

function sequenceUuid() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`;
}

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const diagnostics = [];
  const bus = makeBus();
  installStatusBridge(bus);
  return {
    bus,
    diagnostics,
    on(event, handler) {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
    },
    registerCommand(name, options) {
      commands.set(name, options.handler);
    },
    async emit(event, data, ctx) {
      for (const handler of [...(handlers.get(event) ?? [])]) {
        await handler(data, ctx);
      }
    },
    async runCommand(name, args, ctx) {
      const handler = commands.get(name);
      if (!handler) throw new Error(`unknown command ${name}`);
      await handler(args, ctx);
    },
    events: bus,
  };
}

/**
 * 组装 harness：假时钟 + 假 store + 注册 controller；返回 handle 与 startSession。
 */
function makeHarness({ mode = "rpc" } = {}) {
  const clock = makeClock();
  const store = makeStore();
  const pi = makePi();
  const ui = mode === "tui" ? tuiContext() : rpcContext();
  const deps = {
    agentDir: "/fake/agent-dir",
    now: clock.now,
    randomUUID: sequenceUuid(),
    timers: clock,
    storeFactory: () => store,
    onDiagnostic: (message, error) => pi.diagnostics.push([message, String(error ?? "")]),
  };
  const handle = registerTeamStatus(pi, deps);
  async function startSession(ctx = ui) {
    await pi.emit("session_start", { reason: "startup" }, ctx);
  }
  return { clock, store, pi, ui, deps, handle, startSession };
}

/** 其他 writer 的活跃 shard 夹具（供 observer 聚合）。 */
function foreignShard() {
  return shard({
    writerId: "foreign-writer",
    members: [
      member({ key: "foreign-1", role: "executor", state: "running", title: "Foreign task", updatedAt: NOW, startedAt: NOW }),
    ],
  });
}

// ---------- 生命周期 ----------

test("factory registration starts no timers before session_start", () => {
  const { clock } = makeHarness();
  assert.equal(clock.activeTimerCount(), 0);
});

test("session_start polls once per second and session_shutdown clears every surface", async () => {
  const { clock, store, pi, ui, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  assert.equal(clock.activeTimerCount(), 1);
  await clock.tickAsync(TICK_MS);
  assert.equal(store.readCalls.length, 1);
  await pi.emit("session_shutdown", { reason: "switch" }, ui);
  assert.equal(clock.activeTimerCount(), 0);
  assert.deepEqual(ui.statusCalls.at(-1), ["team-status", undefined]);
  assert.deepEqual(ui.widgetCalls.at(-1), ["team-status", undefined, undefined]);
});

test("repeated session_start without shutdown tears down the old session first", async () => {
  const { clock, store, pi, ui, handle, startSession } = makeHarness({ mode: "tui" });
  await startSession();
  await pi.runCommand("team-panel", "show", ui);
  handle.activateTeam(ui, "Team 协作模式");
  await clock.tickAsync(TICK_MS);
  assert.equal(ui.customCalls.length, 1);
  assert.equal(store.writeCalls.length, 1);

  await startSession(); // 第二次 session_start，未经 shutdown

  assert.equal(clock.activeTimerCount(), 1); // timer 不泄漏：仍只有一个
  assert.equal(ui.doneValues.length, 1); // 旧 overlay 已 dispose（done(null)）
  assert.equal(ui.doneValues[0], null);
  assert.equal(store.removeCalls.length, 1); // 旧会话 shard 已移除
  assert.deepEqual(store.removeCalls[0], [SESSION_ID, store.writeCalls[0].writerId]);

  await clock.tickAsync(TICK_MS); // 最新 generation（observer）独自投影/写
  assert.equal(store.writeCalls.length, 1); // 第二次会话不再写
  assert.equal(ui.customCalls.length, 1); // auto + 空聚合不再挂新 overlay
});

test("an observed local dispatch promotes observer to writer", async () => {
  const { clock, store, pi, ui, startSession } = makeHarness({ mode: "tui" });
  await startSession();
  await pi.emit("tool_execution_start", toolStart("subagent", "call-1", { agent: "executor", task: "Implement" }), ui);
  await clock.tickAsync(2 * TICK_MS);
  assert.equal(store.writeCalls.length, 1);
  assert.equal(store.writeCalls[0].members.some((m) => m.role === "leader"), true);
});

test("management subagent tool start with args.action does not promote observer to writer", async () => {
  const { clock, store, pi, ui, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  await pi.emit("tool_execution_start", toolStart("subagent", "call-mgmt", { action: "spawn", target: "executor" }), ui);
  await clock.tickAsync(2 * TICK_MS);
  assert.equal(store.writeCalls.length, 0);
});

test("pi-web Agent tool start still promotes observer to writer", async () => {
  const { clock, store, pi, ui, startSession } = makeHarness({ mode: "tui" });
  await startSession();
  await pi.emit("tool_execution_start", toolStart("Agent", "call-agent", { subagent_type: "executor", prompt: "Implement" }), ui);
  await clock.tickAsync(2 * TICK_MS);
  assert.equal(store.writeCalls.length, 1);
  assert.equal(store.writeCalls[0].members.some((m) => m.role === "leader"), true);
});

test("observer never writes an empty shard merely by opening a session", async () => {
  const { clock, store, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  await clock.tickAsync(3 * TICK_MS);
  assert.equal(store.writeCalls.length, 0);
});

// ---------- 心跳节奏 ----------

test("leader-only writer heartbeats every 5s", async () => {
  const { clock, store, ui, handle, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  handle.activateTeam(ui, "Team 协作模式");
  await clock.tickAsync(TICK_MS); // t=1s：首次写（leader-only）
  assert.equal(store.writeCalls.length, 1);
  assert.equal(store.writeCalls[0].members.some((m) => m.role === "leader"), true);
  await clock.tickAsync(4 * TICK_MS); // t=2..5s：不应再写
  assert.equal(store.writeCalls.length, 1);
  await clock.tickAsync(TICK_MS); // t=6s：第二个心跳（5s 节奏）
  assert.equal(store.writeCalls.length, 2);
});

test("writer with an active child heartbeats every 2s", async () => {
  const { clock, store, pi, ui, handle, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  handle.activateTeam(ui, "Team 协作模式");
  await pi.emit("tool_execution_update", toolUpdate("subagent", "call-1", runningProgress()), ui);
  await clock.tickAsync(TICK_MS); // t=1s：首次写（leader + active child）
  assert.equal(store.writeCalls.length, 1);
  await clock.tickAsync(TICK_MS); // t=2s：不应写
  assert.equal(store.writeCalls.length, 1);
  await clock.tickAsync(TICK_MS); // t=3s：第二个心跳（2s 节奏）
  assert.equal(store.writeCalls.length, 2);
});

// ---------- 聚合与投影 ----------

test("keeps last-good aggregate after a malformed read", async () => {
  const { clock, store, ui, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  store.state.shards = [foreignShard()];
  await clock.tickAsync(TICK_MS);
  assert.ok(ui.statusCalls.at(-1)[1].includes("running"), "first projection shows member");
  store.state.failNextRead = true;
  await clock.tickAsync(TICK_MS);
  assert.ok(ui.statusCalls.at(-1)[1].includes("running"), "last-good projection retained");
});

test("controller prunes terminal members after 30s", async () => {
  const { clock, store, pi, ui, handle, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  handle.activateTeam(ui, "Team 协作模式");
  await pi.emit("tool_execution_end", toolEnd("subagent", "call-done", completedResult()), ui);
  await clock.tickAsync(TICK_MS); // t=1s：写 leader + completed child
  assert.ok(store.writeCalls.at(-1).members.some((m) => m.state === "completed"));
  await clock.tickAsync(31 * TICK_MS); // 越过 30s 保留窗口
  assert.equal(store.writeCalls.at(-1).members.some((m) => m.state === "completed"), false);
});

test("session_shutdown removes own shard", async () => {
  const { clock, store, pi, ui, handle, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  handle.activateTeam(ui, "Team 协作模式");
  await clock.tickAsync(TICK_MS);
  assert.equal(store.writeCalls.length, 1);
  await pi.emit("session_shutdown", { reason: "switch" }, ui);
  assert.equal(store.removeCalls.length, 1);
  assert.deepEqual(store.removeCalls[0], [SESSION_ID, store.writeCalls[0].writerId]);
});

// ---------- /team-panel 状态机 ----------

test("/team-panel show keeps projection even with no members", async () => {
  const { clock, pi, ui, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  await clock.tickAsync(TICK_MS); // auto + 空 → 清空
  await pi.runCommand("team-panel", "show", ui);
  assert.deepEqual(ui.statusCalls.at(-1), ["team-status", "◆ Team"]);
});

test("/team-panel hide clears every surface", async () => {
  const { clock, store, pi, ui, startSession } = makeHarness({ mode: "tui" });
  await startSession();
  store.state.shards = [foreignShard()];
  await clock.tickAsync(TICK_MS); // auto + 成员 → overlay 显示
  assert.equal(ui.customCalls.length, 1);
  await pi.runCommand("team-panel", "hide", ui);
  assert.deepEqual(ui.statusCalls.at(-1), ["team-status", undefined]);
  assert.equal(ui.doneValues.at(-1), null);
});

test("/team-panel auto shows only when aggregate has members", async () => {
  const { clock, store, ui, startSession } = makeHarness({ mode: "tui" });
  await startSession();
  await clock.tickAsync(TICK_MS); // 空 → 不显示 overlay
  assert.equal(ui.customCalls.length, 0);
  store.state.shards = [foreignShard()];
  await clock.tickAsync(TICK_MS); // 有成员 → 显示
  assert.equal(ui.customCalls.length, 1);
  store.state.shards = [];
  await clock.tickAsync(TICK_MS); // 又空 → 隐藏
  assert.equal(ui.customCalls.length, 1);
  assert.equal(ui.doneValues.at(-1), null);
});

test("/team-panel rejects unknown input without changing mode", async () => {
  const { clock, pi, ui, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  await pi.runCommand("team-panel", "show", ui);
  await pi.runCommand("team-panel", "bogus", ui);
  assert.deepEqual(ui.notifyCalls.at(-1), ["用法: /team-panel show|hide|auto", "error"]);
  await clock.tickAsync(TICK_MS); // 模式应仍为 show，投影继续（而非 auto 清空）
  assert.deepEqual(ui.statusCalls.at(-1), ["team-status", "◆ Team"]);
});

// ---------- 投影面隔离 ----------

test("RPC projection never calls custom overlay", async () => {
  const { clock, store, ui, startSession } = makeHarness({ mode: "rpc" });
  await startSession();
  store.state.shards = [foreignShard()];
  await clock.tickAsync(TICK_MS);
  assert.ok(ui.statusCalls.at(-1)[1].includes("running"));
  assert.equal(ui.customCalls.length, 0);
});

test("TUI projection never sets the details widget", async () => {
  const { clock, store, ui, startSession } = makeHarness({ mode: "tui" });
  await startSession();
  store.state.shards = [foreignShard()];
  await clock.tickAsync(TICK_MS);
  assert.equal(ui.customCalls.length, 1);
  assert.ok(ui.statusCalls.at(-1)[1].includes("running"));
  assert.equal(ui.widgetCalls.length, 0);
});
