/**
 * pi-subagents 前台/异步适配器（Task 6）。
 *
 * 仅依赖 Pi EventBus 结构 RPC 与 pi-subagents 0.56.0 公共 result DTO 形状，
 * 不 import pi-subagents 内部实现。前台成员以父 toolCallId + progress/results 的
 * 数字 index 建 key（绝不 join Fleet opaque key）；异步成员以 launch toolCallId +
 * workflow 子节点遍历位置建 key，根 run 按 exact asyncId 绑定 asyncSnapshot.runs[].id。
 *
 * 存储边界（ruling）：只存净化后的 title / preview / 当前工具；绝不存 currentToolArgs、
 * 完整 task、thinking、完整 result 或工具 args。所有 completed/failed/stopped 终态
 * 转换必须写 terminalAt，供 reducer 的 30s 保留语义使用。
 *
 * RPC 客户端：唯一 requestId，subscribe-before-emit，reply/timeout/dispose 均退订，
 * 同一时刻至多一个在飞 status 请求。artifact preview 只读字面 `<asyncDir>/status.json`，
 * 读前检查大小（至多 1 MiB），绝不由 node id 派生路径。
 */
import { readFile, stat as fspStat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import {
  extractPreview,
  extractTaskTitle,
  makeMemberKey,
  roleForAgent,
  sanitizeDisplayText,
} from "./sanitize.ts";
import {
  MAX_AGENT_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_TEXT_LENGTH,
  type TeamMemberState,
  type TeamMemberStatusV1,
} from "./types.ts";
import { upsertMember, type TeamRuntimeState } from "./reducer.ts";

// ---------- 常量 ----------

/** RPC 状态请求缺省超时。 */
export const DEFAULT_RPC_TIMEOUT_MS = 2000;
/** artifact preview 读取上限：1 MiB。 */
export const MAX_ASYNC_PREVIEW_BYTES = 1024 * 1024;
/** 异步快照节点递归守护上限（防止畸形循环/过深嵌套）。 */
const MAX_NODE_GUARD_DEPTH = 8;

export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_RPC_VERSION = 1;
export const SUBAGENTS_STATUS_KIND = "pi-subagents.status";
export const SUBAGENTS_STATUS_VERSION = 1;

/** 合成 step id（`step:<index>`）不是有意义的标题，显示时回退到 label。 */
const SYNTHETIC_STEP_ID_PATTERN = /^step:\d+$/;

const TERMINAL_MEMBER_STATES: ReadonlySet<TeamMemberState> = new Set(["completed", "failed", "stopped"]);

function isTerminalState(state: TeamMemberState): boolean {
  return TERMINAL_MEMBER_STATES.has(state);
}

// ---------- 公共 DTO 形状（pi-subagents 结构投影，不 import 内部） ----------

export type AsyncStatusNodeState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped" | "rejected";
export type AsyncStatusNodeKind = "subagent" | "workflow" | "step";

export interface AsyncStatusActivityV1 {
  state?: string;
  currentTool?: string;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  turnCount?: number;
  toolCount?: number;
}

export interface AsyncStatusNodeV1 {
  id: string;
  kind: AsyncStatusNodeKind;
  label: string;
  state: AsyncStatusNodeState;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  activity?: AsyncStatusActivityV1;
  children?: AsyncStatusNodeV1[];
}

export interface AsyncStatusSnapshotV1 {
  kind: "pi-subagents.async-status-snapshot";
  version: 1;
  generatedAt: number;
  caps: { maxRuns: number; maxChildrenPerNode: number; maxDepth: number; maxStringLength: number; maxSerializedBytes: number };
  omitted: { runs: number; children: number; byteLimitExceeded: boolean };
  runs: AsyncStatusNodeV1[];
}

export interface SubagentsFleetEntryV1 {
  key: string;
  agent: string;
  role?: string;
  model?: string;
  effort?: string;
  startedAt: number;
  tokens: { input: number; output: number; total: number };
  goal?: string;
}

export interface SubagentsFleetStatusV1 {
  version: 1;
  entries: SubagentsFleetEntryV1[];
  totalActive: number;
  topLevelAsyncCapacity: { used: number; limit: number };
  omitted: number;
}

/** RPC `status` 的公共投影：可选 fleet / asyncSnapshot。 */
export interface SubagentsStatusV1 {
  kind: typeof SUBAGENTS_STATUS_KIND;
  version: typeof SUBAGENTS_STATUS_VERSION;
  fleet?: SubagentsFleetStatusV1;
  asyncSnapshot?: AsyncStatusSnapshotV1;
}

/** EventBus 结构契约（与 Pi createEventBus() 兼容，仅声明所需成员）。 */
export interface SubagentsEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

// ---------- 守卫（防畸形，绝不抛出到调用方） ----------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function guardNodeState(value: unknown): AsyncStatusNodeState | undefined {
  const states: readonly AsyncStatusNodeState[] = ["queued", "running", "complete", "failed", "paused", "stopped", "rejected"];
  return typeof value === "string" && (states as readonly string[]).includes(value)
    ? (value as AsyncStatusNodeState)
    : undefined;
}

function guardNodeKind(value: unknown): AsyncStatusNodeKind {
  return value === "subagent" || value === "workflow" || value === "step" ? value : "step";
}

function guardActivity(value: unknown): AsyncStatusActivityV1 | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const activity: AsyncStatusActivityV1 = {};
  const state = asString(rec.state);
  if (state) activity.state = state;
  const currentTool = asString(rec.currentTool);
  if (currentTool) activity.currentTool = currentTool;
  const lastActivityAt = finiteNumber(rec.lastActivityAt);
  if (lastActivityAt !== undefined) activity.lastActivityAt = lastActivityAt;
  const currentToolStartedAt = finiteNumber(rec.currentToolStartedAt);
  if (currentToolStartedAt !== undefined) activity.currentToolStartedAt = currentToolStartedAt;
  const turnCount = finiteNumber(rec.turnCount);
  if (turnCount !== undefined) activity.turnCount = turnCount;
  const toolCount = finiteNumber(rec.toolCount);
  if (toolCount !== undefined) activity.toolCount = toolCount;
  return Object.keys(activity).length > 0 ? activity : undefined;
}

function guardNode(value: unknown, depth: number): AsyncStatusNodeV1 | undefined {
  if (depth > MAX_NODE_GUARD_DEPTH) return undefined;
  const rec = asRecord(value);
  if (!rec) return undefined;
  const id = asString(rec.id);
  if (!id) return undefined;
  const state = guardNodeState(rec.state);
  if (!state) return undefined;
  const node: AsyncStatusNodeV1 = {
    id,
    kind: guardNodeKind(rec.kind),
    label: asString(rec.label) ?? "",
    state,
  };
  const startedAt = finiteNumber(rec.startedAt);
  if (startedAt !== undefined) node.startedAt = startedAt;
  const updatedAt = finiteNumber(rec.updatedAt);
  if (updatedAt !== undefined) node.updatedAt = updatedAt;
  const endedAt = finiteNumber(rec.endedAt);
  if (endedAt !== undefined) node.endedAt = endedAt;
  const activity = guardActivity(rec.activity);
  if (activity) node.activity = activity;
  if (Array.isArray(rec.children)) {
    const children: AsyncStatusNodeV1[] = [];
    for (const child of rec.children) {
      const guarded = guardNode(child, depth + 1);
      if (guarded) children.push(guarded);
    }
    if (children.length > 0) node.children = children;
  }
  return node;
}

function guardAsyncSnapshot(value: unknown): AsyncStatusSnapshotV1 | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  if (rec.kind !== "pi-subagents.async-status-snapshot" || rec.version !== 1) return undefined;
  if (!Array.isArray(rec.runs)) return undefined;
  const caps = asRecord(rec.caps);
  const omitted = asRecord(rec.omitted);
  const snapshot: AsyncStatusSnapshotV1 = {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: finiteNumber(rec.generatedAt) ?? 0,
    caps: {
      maxRuns: finiteNumber(caps?.maxRuns) ?? 0,
      maxChildrenPerNode: finiteNumber(caps?.maxChildrenPerNode) ?? 0,
      maxDepth: finiteNumber(caps?.maxDepth) ?? 0,
      maxStringLength: finiteNumber(caps?.maxStringLength) ?? 0,
      maxSerializedBytes: finiteNumber(caps?.maxSerializedBytes) ?? 0,
    },
    omitted: {
      runs: finiteNumber(omitted?.runs) ?? 0,
      children: finiteNumber(omitted?.children) ?? 0,
      byteLimitExceeded: omitted?.byteLimitExceeded === true,
    },
    runs: [],
  };
  for (const run of rec.runs) {
    const guarded = guardNode(run, 0);
    if (guarded) snapshot.runs.push(guarded);
  }
  return snapshot;
}

function guardFleetEntry(value: unknown): SubagentsFleetEntryV1 | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const key = asString(rec.key);
  const agent = asString(rec.agent);
  const startedAt = finiteNumber(rec.startedAt);
  if (!key || !agent || startedAt === undefined) return undefined;
  const tokens = asRecord(rec.tokens);
  const entry: SubagentsFleetEntryV1 = {
    key,
    agent,
    startedAt,
    tokens: {
      input: finiteNumber(tokens?.input) ?? 0,
      output: finiteNumber(tokens?.output) ?? 0,
      total: finiteNumber(tokens?.total) ?? 0,
    },
  };
  const role = asString(rec.role);
  if (role) entry.role = role;
  const model = asString(rec.model);
  if (model) entry.model = model;
  const effort = asString(rec.effort);
  if (effort) entry.effort = effort;
  const goal = asString(rec.goal);
  if (goal) entry.goal = goal;
  return entry;
}

function guardFleetStatus(value: unknown): SubagentsFleetStatusV1 | undefined {
  const rec = asRecord(value);
  if (!rec || rec.version !== 1) return undefined;
  const entries: SubagentsFleetEntryV1[] = [];
  if (Array.isArray(rec.entries)) {
    for (const entry of rec.entries) {
      const guarded = guardFleetEntry(entry);
      if (guarded) entries.push(guarded);
    }
  }
  const capacity = asRecord(rec.topLevelAsyncCapacity);
  return {
    version: 1,
    entries,
    totalActive: finiteNumber(rec.totalActive) ?? 0,
    topLevelAsyncCapacity: {
      used: finiteNumber(capacity?.used) ?? 0,
      limit: finiteNumber(capacity?.limit) ?? 0,
    },
    omitted: finiteNumber(rec.omitted) ?? 0,
  };
}

/** 解析 status 成功回包信封；任何畸形一律返回 undefined，绝不抛出。 */
function parseStatusReply(data: unknown, expectedRequestId: string): SubagentsStatusV1 | undefined {
  const rec = asRecord(data);
  if (!rec) return undefined;
  if (rec.version !== SUBAGENT_RPC_VERSION) return undefined;
  if (rec.requestId !== expectedRequestId) return undefined;
  if (rec.success !== true) return undefined;
  const payload = asRecord(rec.data);
  if (!payload) return undefined;
  const status: SubagentsStatusV1 = {
    kind: SUBAGENTS_STATUS_KIND,
    version: SUBAGENTS_STATUS_VERSION,
  };
  const fleet = guardFleetStatus(payload.fleet);
  if (fleet) status.fleet = fleet;
  const snapshot = guardAsyncSnapshot(payload.asyncSnapshot);
  if (snapshot) status.asyncSnapshot = snapshot;
  return status;
}

// ---------- 文本净化辅助 ----------

function sanitizePreviewLines(lines: string[], maxLines = 2): string[] {
  return lines
    .map((line) => sanitizeDisplayText(line, MAX_TEXT_LENGTH))
    .filter((line) => line.length > 0)
    .slice(-maxLines);
}

function currentToolPreview(currentTool: unknown): string[] {
  const raw = asString(currentTool);
  if (!raw) return [];
  const tool = sanitizeDisplayText(raw, MAX_TEXT_LENGTH);
  return tool ? [`Running ${tool}`] : [];
}

// ---------- RPC 客户端 ----------

export interface SubagentsRpcClientOptions {
  events: SubagentsEventBus;
  randomUUID?: () => string;
  defaultTimeoutMs?: number;
}

export class SubagentsRpcClient {
  private readonly events: SubagentsEventBus;
  private readonly randomUUID: () => string;
  private readonly defaultTimeoutMs: number;
  private disposed = false;
  private inflight = false;
  private activeUnsub: (() => void) | undefined;
  private activeTimer: ReturnType<typeof setTimeout> | undefined;
  private activeSettle: ((value: SubagentsStatusV1 | undefined) => void) | undefined;

  constructor(options: SubagentsRpcClientOptions) {
    this.events = options.events;
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  /** 发起唯一 status 请求；reply/timeout 退订；同一时刻至多一个在飞请求。 */
  status(timeoutMs = this.defaultTimeoutMs): Promise<SubagentsStatusV1 | undefined> {
    if (this.disposed || this.inflight) return Promise.resolve(undefined);
    this.inflight = true;
    const requestId = this.randomUUID();
    const channel = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
    return new Promise<SubagentsStatusV1 | undefined>((resolve) => {
      let settled = false;
      const settle = (value: SubagentsStatusV1 | undefined): void => {
        if (settled) return;
        settled = true;
        this.inflight = false;
        this.clearActive();
        resolve(value);
      };
      this.activeSettle = settle;
      const unsub = this.events.on(channel, (reply) => settle(parseStatusReply(reply, requestId)));
      this.activeUnsub = typeof unsub === "function" ? unsub : undefined;
      this.activeTimer = setTimeout(() => settle(undefined), timeoutMs);
      // subscribe-before-emit：先挂监听再发请求；emit 同步抛出时走正常清理路径。
      try {
        this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
          version: SUBAGENT_RPC_VERSION,
          requestId,
          method: "status",
          params: {},
        });
      } catch {
        settle(undefined);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.inflight = false;
    const settle = this.activeSettle;
    this.clearActive();
    if (settle) settle(undefined);
  }

  private clearActive(): void {
    if (this.activeTimer !== undefined) {
      clearTimeout(this.activeTimer);
      this.activeTimer = undefined;
    }
    if (this.activeUnsub) {
      this.activeUnsub();
      this.activeUnsub = undefined;
    }
    this.activeSettle = undefined;
  }
}

// ---------- 可选 artifact 投影 ----------

/**
 * 只读字面 `<asyncDir>/status.json` 的有界 step 投影：读前检查大小（≤ maxBytes，
 * 缺省 1 MiB），解析失败/缺失一律返回空投影。childIndex 仅作 steps 数组位置索引，
 * 绝不参与路径派生（忽略任何 path-like node id）。单次读取同时返回该 step 的
 * 净化 agent、model 与至多两行净化 recentOutput（绝不读 thinking/敏感字段）。
 */
export interface AsyncStepProjection {
  agent?: string;
  model?: string;
  /** 净化后的 workflowKey 关联提示：用于防御 steps/children 顺序错位，绝不写入 Team DTO。 */
  workflowKey?: string;
  preview: string[];
}

export async function readAsyncStep(asyncDir: string, childIndex: number, maxBytes = MAX_ASYNC_PREVIEW_BYTES): Promise<AsyncStepProjection> {
  const statusPath = join(asyncDir, "status.json");
  try {
    const stat = await fspStat(statusPath);
    if (!stat.isFile()) return { preview: [] };
    if (stat.size > maxBytes) return { preview: [] };
  } catch {
    return { preview: [] };
  }
  let text: string;
  try {
    text = await readFile(statusPath, "utf8");
  } catch {
    return { preview: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { preview: [] };
  }
  const rec = asRecord(parsed);
  if (!rec) return { preview: [] };
  if (!Array.isArray(rec.steps)) return { preview: [] };
  const step = asRecord(rec.steps[childIndex]);
  if (!step) return { preview: [] };
  const agent = asString(step.agent);
  const model = asString(step.model);
  const workflowKey = asString(step.workflowKey);
  const recentOutput = asStringArray(step.recentOutput);
  const projection: AsyncStepProjection = { preview: [] };
  if (agent) projection.agent = sanitizeDisplayText(agent, MAX_AGENT_LENGTH) || undefined;
  if (model) projection.model = sanitizeDisplayText(model, MAX_MODEL_LENGTH) || undefined;
  if (workflowKey) projection.workflowKey = sanitizeDisplayText(workflowKey, MAX_TEXT_LENGTH) || undefined;
  if (recentOutput && recentOutput.length > 0) projection.preview = sanitizePreviewLines(recentOutput, 2);
  return projection;
}

/**
 * 便捷导出：仅取投影的 preview 行（≤ 2）。供既有的 preview 单测/调用方使用；
 * 生产轮询路径应直接使用 readAsyncStep 以免同一次轮询内重复读文件。
 */
export async function readAsyncPreview(asyncDir: string, childIndex: number, maxBytes = MAX_ASYNC_PREVIEW_BYTES): Promise<string[]> {
  const projection = await readAsyncStep(asyncDir, childIndex, maxBytes);
  return projection.preview;
}

// ---------- 适配器 ----------

export interface PiSubagentsAdapterOptions {
  events: SubagentsEventBus;
  runtime: TeamRuntimeState;
  now: () => number;
  onChanged: () => void;
  readAsyncStep?: (asyncDir: string, childIndex: number, maxBytes: number) => Promise<AsyncStepProjection>;
  rpcTimeoutMs?: number;
  randomUUID?: () => string;
}

export interface PiSubagentsAdapter {
  onToolStart(event: unknown): void;
  onToolUpdate(event: unknown): void;
  onToolEnd(event: unknown): void;
  refreshAsync(): Promise<void>;
  dispose(): void;
}

interface LaunchContext {
  agent?: string;
  task?: string;
  mode?: string;
}

interface AsyncRunRecord {
  asyncDir: string;
  toolCallId: string;
}

/** 从包装 `{ content, details }` 或裸 Details 中取 details 记录（守卫两种公共形状）。 */
function coerceDetails(payload: unknown): Record<string, unknown> | undefined {
  const rec = asRecord(payload);
  if (!rec) return undefined;
  const details = asRecord(rec.details);
  if (details) return details;
  if ("progress" in rec || "results" in rec || "runId" in rec || "asyncId" in rec) return rec;
  return undefined;
}

function mapForegroundStatus(status: unknown): TeamMemberState {
  switch (status) {
    case "pending": return "starting";
    case "running": return "running";
    case "completed": return "completed";
    case "failed": return "failed";
    case "detached": return "stopped";
    default: return "running";
  }
}

function mapResultState(rec: Record<string, unknown>): TeamMemberState {
  if (rec.stopped === true || rec.interrupted === true || rec.detached === true) return "stopped";
  if (rec.timedOut === true) return "failed";
  // 任何非 null 的 error（字符串或对象形状）都判 failed。
  if (rec.error != null) return "failed";
  const exitCode = rec.exitCode;
  // 仅当 exitCode 是有限整数时判失败，避免 NaN/Infinity 造成误报。
  if (Number.isInteger(exitCode) && exitCode !== 0) return "failed";
  return "completed";
}

function mapAsyncState(state: string): TeamMemberState {
  switch (state) {
    case "queued": return "starting";
    case "running": return "running";
    case "complete":
    case "completed": return "completed";
    case "failed":
    case "rejected": return "failed";
    // paused 仍存续（可恢复），不判终态，避免被 30s 保留语义误清理。
    case "paused": return "starting";
    case "stopped": return "stopped";
    default: return "running";
  }
}

export function createPiSubagentsAdapter(options: PiSubagentsAdapterOptions): PiSubagentsAdapter {
  const runtime = options.runtime;
  const now = options.now;
  const onChanged = options.onChanged;
  const readStep = options.readAsyncStep ?? readAsyncStep;
  const rpc = new SubagentsRpcClient({
    events: options.events,
    randomUUID: options.randomUUID,
    defaultTimeoutMs: options.rpcTimeoutMs,
  });

  const launchContext = new Map<string, LaunchContext>();
  const ignored = new Set<string>();
  const asyncRuns = new Map<string, AsyncRunRecord>();
  const asyncMemberKeys = new Map<string, string[]>();
  let changed = false;

  function touch(): void {
    changed = true;
  }

  function flushChanged(): void {
    if (!changed) return;
    changed = false;
    onChanged();
  }

  function mergeUpsert(member: TeamMemberStatusV1): void {
    const existing = runtime.members.get(member.key);
    const agent = member.agent ?? existing?.agent;
    const role = member.agent ? member.role : (agent ? roleForAgent(agent) : member.role);
    const merged: TeamMemberStatusV1 = {
      key: member.key,
      role,
      agent,
      model: member.model ?? existing?.model,
      title: member.title || existing?.title || "",
      preview: member.preview.length > 0 ? member.preview : existing?.preview ?? [],
      state: member.state,
      startedAt: existing?.startedAt ?? member.startedAt,
      updatedAt: member.updatedAt,
    };
    if (member.terminalAt !== undefined) {
      merged.terminalAt = existing?.terminalAt !== undefined ? existing.terminalAt : member.terminalAt;
    }
    upsertMember(runtime, merged);
    touch();
  }

  function buildForegroundMember(args: {
    toolCallId: string;
    index: number;
    agent: string | undefined;
    model: string | undefined;
    task: string | undefined;
    state: TeamMemberState;
    preview: string[];
  }): TeamMemberStatusV1 {
    const member: TeamMemberStatusV1 = {
      key: makeMemberKey(runtime.writerId, args.toolCallId, args.index),
      role: roleForAgent(args.agent),
      agent: args.agent ? sanitizeDisplayText(args.agent, MAX_AGENT_LENGTH) : undefined,
      model: args.model ? sanitizeDisplayText(args.model, MAX_MODEL_LENGTH) || undefined : undefined,
      title: extractTaskTitle(args.task),
      preview: args.preview,
      state: args.state,
      startedAt: now(),
      updatedAt: now(),
    };
    if (isTerminalState(args.state)) member.terminalAt = now();
    return member;
  }

  function progressPreview(rec: Record<string, unknown>): string[] {
    const recentOutput = asStringArray(rec.recentOutput);
    if (recentOutput && recentOutput.length > 0) return sanitizePreviewLines(recentOutput, 2);
    return currentToolPreview(rec.currentTool);
  }

  function resultPreview(rec: Record<string, unknown>): string[] {
    const progress = asRecord(rec.progress);
    const recentOutput = asStringArray(rec.recentOutput) ?? asStringArray(progress?.recentOutput);
    if (recentOutput && recentOutput.length > 0) return sanitizePreviewLines(recentOutput, 2);
    const finalOutput = asString(rec.finalOutput);
    if (finalOutput) return extractPreview(finalOutput, 2);
    return currentToolPreview(rec.currentTool ?? progress?.currentTool);
  }

  function processableToolCallId(event: unknown): string | undefined {
    const rec = asRecord(event);
    if (!rec || rec.toolName !== "subagent") return undefined;
    const toolCallId = asString(rec.toolCallId);
    if (!toolCallId) return undefined;
    if (ignored.has(toolCallId)) return undefined;
    const args = asRecord(rec.args);
    if (args && args.action !== undefined) {
      ignored.add(toolCallId);
      return undefined;
    }
    return toolCallId;
  }

  function recordAsyncLaunch(toolCallId: string, details: Record<string, unknown>): boolean {
    const asyncId = asString(details.asyncId);
    const asyncDir = asString(details.asyncDir);
    if (!asyncId || !asyncDir) return false;
    asyncRuns.set(asyncId, { asyncDir, toolCallId });
    return true;
  }

  function onToolStart(event: unknown): void {
    const toolCallId = processableToolCallId(event);
    if (!toolCallId) return;
    const rec = asRecord(event);
    const args = asRecord(rec?.args) ?? {};
    launchContext.set(toolCallId, {
      agent: asString(args.agent),
      task: asString(args.task),
      mode: asString(args.mode),
    });
  }

  function onToolUpdate(event: unknown): void {
    const toolCallId = processableToolCallId(event);
    if (!toolCallId) return;
    const rec = asRecord(event);
    const details = coerceDetails(rec?.partialResult);
    if (!details) return;
    const ctx = launchContext.get(toolCallId);
    if (recordAsyncLaunch(toolCallId, details)) {
      touch();
      flushChanged();
      return;
    }
    const progress = Array.isArray(details.progress) ? details.progress : [];
    for (const entry of progress) {
      const item = asRecord(entry);
      if (!item) continue;
      const index = nonNegativeIndex(item.index);
      if (index === undefined) continue;
      mergeUpsert(buildForegroundMember({
        toolCallId,
        index,
        agent: asString(item.agent) ?? ctx?.agent,
        model: asString(item.model),
        task: asString(item.task) ?? ctx?.task,
        state: mapForegroundStatus(item.status),
        preview: progressPreview(item),
      }));
    }
    flushChanged();
  }

  function onToolEnd(event: unknown): void {
    const toolCallId = processableToolCallId(event);
    if (!toolCallId) return;
    const rec = asRecord(event);
    const details = coerceDetails(rec?.result);
    if (!details) return;
    const ctx = launchContext.get(toolCallId);
    if (recordAsyncLaunch(toolCallId, details)) {
      touch();
      flushChanged();
      return;
    }
    const results = Array.isArray(details.results) ? details.results : [];
    for (const entry of results) {
      const item = asRecord(entry);
      if (!item) continue;
      const index = nonNegativeIndex(item.index);
      if (index === undefined) continue;
      mergeUpsert(buildForegroundMember({
        toolCallId,
        index,
        agent: asString(item.agent) ?? ctx?.agent,
        model: asString(item.model),
        task: asString(item.task) ?? ctx?.task,
        state: mapResultState(item),
        preview: resultPreview(item),
      }));
    }
    flushChanged();
  }

  function asyncTitle(node: AsyncStatusNodeV1): string {
    if (node.id && !SYNTHETIC_STEP_ID_PATTERN.test(node.id)) {
      return sanitizeDisplayText(node.id, MAX_TEXT_LENGTH);
    }
    const label = sanitizeDisplayText(node.label, MAX_TEXT_LENGTH);
    if (label) return label;
    return sanitizeDisplayText(node.id, MAX_TEXT_LENGTH);
  }

  function buildAsyncMember(args: {
    toolCallId: string;
    childIndex: number;
    node: AsyncStatusNodeV1;
    artifactAgent: string | undefined;
    artifactModel: string | undefined;
    preview: string[];
  }): TeamMemberStatusV1 {
    const { toolCallId, childIndex, node, artifactAgent, artifactModel, preview } = args;
    const state = mapAsyncState(node.state);
    const agentSource = artifactAgent ?? node.label;
    const member: TeamMemberStatusV1 = {
      key: makeMemberKey(runtime.writerId, toolCallId, childIndex),
      role: roleForAgent(agentSource),
      agent: sanitizeDisplayText(agentSource, MAX_AGENT_LENGTH) || undefined,
      model: artifactModel ? sanitizeDisplayText(artifactModel, MAX_MODEL_LENGTH) || undefined : undefined,
      title: asyncTitle(node),
      preview,
      state,
      startedAt: node.startedAt ?? now(),
      updatedAt: node.updatedAt ?? now(),
    };
    if (isTerminalState(state)) {
      member.terminalAt = node.endedAt ?? node.updatedAt ?? now();
    }
    return member;
  }

  interface ResolvedAsyncArtifact {
    agent?: string;
    model?: string;
    preview: string[];
  }

  /**
   * artifact workflowKey 关联守卫：status.json step 携带非空 workflowKey 时，必须与公开
   * node.id 一致。仅对 step 节点做关联；childless 根节点（subagent/workflow）走「位置
   * 索引」富集，直接接受 steps[0]。合成 `step:N` id 无真实 workflowKey，遇非空 hint 即
   * 保守拒绝。顺序错位 → 丢弃整份投影，回退到公开 node.label / currentTool。
   */
  function artifactCorrelationMatches(projection: AsyncStepProjection, node: AsyncStatusNodeV1): boolean {
    const hint = projection.workflowKey;
    if (!hint) return true;
    if (node.kind !== "step") return true;
    if (SYNTHETIC_STEP_ID_PATTERN.test(node.id)) return false;
    return hint === node.id;
  }

  async function resolveAsyncArtifact(asyncDir: string, childIndex: number, node: AsyncStatusNodeV1): Promise<ResolvedAsyncArtifact> {
    let projection: AsyncStepProjection = { preview: [] };
    try {
      projection = await readStep(asyncDir, childIndex, MAX_ASYNC_PREVIEW_BYTES);
    } catch {
      projection = { preview: [] };
    }
    if (!artifactCorrelationMatches(projection, node)) {
      return { preview: currentToolPreview(node.activity?.currentTool) };
    }
    const preview = sanitizePreviewLines(projection.preview, 2);
    if (preview.length > 0) {
      return { agent: projection.agent, model: projection.model, preview };
    }
    return { agent: projection.agent, model: projection.model, preview: currentToolPreview(node.activity?.currentTool) };
  }

  async function upsertAsyncRun(asyncId: string, record: AsyncRunRecord, run: AsyncStatusNodeV1): Promise<void> {
    const nodes = run.children && run.children.length > 0 ? run.children : [run];
    const keys: string[] = [];
    for (let childIndex = 0; childIndex < nodes.length; childIndex++) {
      const node = nodes[childIndex];
      const key = makeMemberKey(runtime.writerId, record.toolCallId, childIndex);
      keys.push(key);
      const artifact = await resolveAsyncArtifact(record.asyncDir, childIndex, node);
      mergeUpsert(buildAsyncMember({
        toolCallId: record.toolCallId,
        childIndex,
        node,
        artifactAgent: artifact.agent,
        artifactModel: artifact.model,
        preview: artifact.preview,
      }));
    }
    const previousKeys = asyncMemberKeys.get(asyncId) ?? [];
    asyncMemberKeys.set(asyncId, keys);
    for (const previous of previousKeys) {
      if (keys.includes(previous)) continue;
      const existing = runtime.members.get(previous);
      if (existing && !isTerminalState(existing.state)) {
        upsertMember(runtime, { ...existing, state: "stopped", updatedAt: now(), terminalAt: now() });
        touch();
      }
    }
  }

  async function refreshAsync(): Promise<void> {
    const status = await rpc.status();
    if (!status?.asyncSnapshot) return;
    const snapshot = status.asyncSnapshot;
    const seen = new Set<string>();
    for (const [asyncId, record] of asyncRuns) {
      const run = snapshot.runs.find((candidate) => candidate.id === asyncId);
      if (!run) continue;
      seen.add(asyncId);
      await upsertAsyncRun(asyncId, record, run);
    }
    // 快照中已消失的 run：把其成员标记为 stopped 终态（terminalAt），交给 reducer 30s 保留。
    for (const [asyncId, keys] of asyncMemberKeys) {
      if (seen.has(asyncId)) continue;
      for (const key of keys) {
        const existing = runtime.members.get(key);
        if (existing && !isTerminalState(existing.state)) {
          upsertMember(runtime, { ...existing, state: "stopped", updatedAt: now(), terminalAt: now() });
          touch();
        }
      }
    }
    flushChanged();
  }

  function dispose(): void {
    rpc.dispose();
    launchContext.clear();
    ignored.clear();
    asyncRuns.clear();
    asyncMemberKeys.clear();
  }

  return { onToolStart, onToolUpdate, onToolEnd, refreshAsync, dispose };
}
