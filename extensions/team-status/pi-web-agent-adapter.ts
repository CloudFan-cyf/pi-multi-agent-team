/**
 * pi-web 内建 `Agent` 适配器（Task 7）。
 *
 * 仅观察父进程工具名 `Agent` 与 `message_end` 自定义消息
 * `pi-web:subagent-notification`，不 import pi-web 模块、不调用 pi-web HTTP 路由、
 * 不读子会话文件、不持久化完整 prompt/result 或任何敏感字段。
 *
 * 关联语义（规格 §7.3）：
 * - start 用 toolCallId + subagent_type/prompt/description/run_in_background 建立成员，
 *   角色按精确 Team profile 映射，未知一律 "other"；
 * - update/end 只接受 details.kind === "pi-web-subagent"；details 一旦出现 sessionId
 *   即保留 sessionId → memberKey（adapter 本地，绝不序列化）；
 * - 前台 end 从 result content 提取安全 preview，并对 completed/failed/aborted/interrupted
 *   写 terminalAt（交给 reducer 的 30s 保留语义）；
 * - 后台 end 保持 running，终态与 preview 由匹配 details.sessionId 的 message_end 通知驱动。
 *
 * 所有无关/畸形事件绝不抛出、绝不破坏既有状态；onChanged 仅在真实成员变更时触发。
 */
import {
  extractPreview,
  extractTaskTitle,
  makeMemberKey,
  roleForAgent,
  sanitizeDisplayText,
} from "./sanitize.ts";
import {
  MAX_AGENT_LENGTH,
  MAX_TEXT_LENGTH,
  type TeamMemberState,
  type TeamMemberStatusV1,
} from "./types.ts";
import { upsertMember, type TeamRuntimeState } from "./reducer.ts";

// ---------- 常量 ----------

/** pi-web 内建子代理工具名。 */
const PI_WEB_TOOL_NAME = "Agent";
/** pi-web 子代理 details 判别字面量。 */
const PI_WEB_SUBAGENT_KIND = "pi-web-subagent";
/** pi-web 后台完成通知的自定义消息类型。 */
const PI_WEB_NOTIFICATION_CUSTOM_TYPE = "pi-web:subagent-notification";
/** pi-web 子代理成员固定 child index（每个 toolCallId 至多一个成员）。 */
const PI_WEB_CHILD_INDEX = 0;

const TERMINAL_MEMBER_STATES: ReadonlySet<TeamMemberState> = new Set(["completed", "failed", "stopped"]);

function isTerminalState(state: TeamMemberState): boolean {
  return TERMINAL_MEMBER_STATES.has(state);
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

// ---------- 状态与内容提取 ----------

/** pi-web 状态 → TeamMemberState；未知状态保守视为 running（非终态）。 */
function mapPiWebStatus(status: unknown): TeamMemberState {
  switch (status) {
    case "starting":
    case "queued":
    case "pending":
      return "starting";
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "aborted":
    case "interrupted":
    case "stopped":
    case "cancelled":
      return "stopped";
    default:
      return "running";
  }
}

/** 从 content（字符串或 `{type:"text",text}` 块数组）提取纯文本。 */
function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    const rec = asRecord(block);
    const text = asString(rec?.text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function contentPreview(content: unknown): string[] {
  const text = extractContentText(content);
  if (!text) return [];
  return extractPreview(text, 2);
}

function sanitizePreviewLines(lines: string[], maxLines = 2): string[] {
  return lines
    .map((line) => sanitizeDisplayText(line, MAX_TEXT_LENGTH))
    .filter((line) => line.length > 0)
    .slice(-maxLines);
}

/** 从 `{ content, details }` 包装或裸 details 中取 kind 匹配的 details + content。 */
function coercePiWebDetails(payload: unknown): { details: Record<string, unknown>; content: unknown } | undefined {
  const rec = asRecord(payload);
  if (!rec) return undefined;
  const details = asRecord(rec.details);
  if (details && details.kind === PI_WEB_SUBAGENT_KIND) {
    return { details, content: rec.content };
  }
  if (rec.kind === PI_WEB_SUBAGENT_KIND) {
    return { details: rec, content: rec.content };
  }
  return undefined;
}

/** 通知 preview：优先取自定义消息 content，回退到 details.preview / details.result。 */
function notificationPreview(message: Record<string, unknown>, details: Record<string, unknown>): string[] {
  const preview = contentPreview(message.content);
  if (preview.length > 0) return preview;
  const detailsPreview = details.preview;
  if (typeof detailsPreview === "string") return extractPreview(detailsPreview, 2);
  if (Array.isArray(detailsPreview)) {
    const lines = detailsPreview.filter((item): item is string => typeof item === "string");
    if (lines.length > 0) return sanitizePreviewLines(lines, 2);
  }
  const resultText = asString(details.result);
  if (resultText) return extractPreview(resultText, 2);
  return [];
}

// ---------- 适配器 ----------

export interface PiWebAgentAdapterOptions {
  runtime: TeamRuntimeState;
  now: () => number;
  onChanged: () => void;
}

export interface PiWebAgentAdapter {
  onToolStart(event: unknown): void;
  onToolUpdate(event: unknown): void;
  onToolEnd(event: unknown): void;
  onMessageEnd(event: unknown): void;
  dispose(): void;
}

interface AgentLaunchContext {
  subagentType?: string;
  prompt?: string;
  description?: string;
  runInBackground?: boolean;
}

export function createPiWebAgentAdapter(options: PiWebAgentAdapterOptions): PiWebAgentAdapter {
  const runtime = options.runtime;
  const now = options.now;
  const onChanged = options.onChanged;

  const launchContext = new Map<string, AgentLaunchContext>();
  const sessionMembers = new Map<string, string>();
  let changed = false;

  function touch(): void {
    changed = true;
  }

  function flushChanged(): void {
    if (!changed) return;
    changed = false;
    onChanged();
  }

  function memberKey(toolCallId: string): string {
    return makeMemberKey(runtime.writerId, toolCallId, PI_WEB_CHILD_INDEX);
  }

  /** 按稳定 key 归并 upsert；保留既有 role/title/preview/terminalAt 的首值。 */
  function upsertMemberAt(key: string, args: {
    profile?: string;
    title?: string;
    state: TeamMemberState;
    preview: string[];
  }): void {
    const existing = runtime.members.get(key);
    const agent = args.profile ? sanitizeDisplayText(args.profile, MAX_AGENT_LENGTH) : undefined;
    const member: TeamMemberStatusV1 = {
      key,
      role: existing?.role ?? roleForAgent(args.profile),
      agent: agent ?? existing?.agent,
      title: args.title || existing?.title || "",
      preview: args.preview.length > 0 ? args.preview : (existing?.preview ?? []),
      state: args.state,
      startedAt: existing?.startedAt ?? now(),
      updatedAt: now(),
    };
    if (isTerminalState(args.state)) {
      member.terminalAt = existing?.terminalAt ?? now();
    }
    upsertMember(runtime, member);
    touch();
  }

  /** 仅当事件是 `Agent` 工具且带非空 toolCallId 时返回该 id。 */
  function processableAgentCall(event: unknown): string | undefined {
    const rec = asRecord(event);
    if (!rec || rec.toolName !== PI_WEB_TOOL_NAME) return undefined;
    const toolCallId = asString(rec.toolCallId);
    return toolCallId || undefined;
  }

  function onToolStart(event: unknown): void {
    const rec = asRecord(event);
    if (!rec || rec.toolName !== PI_WEB_TOOL_NAME) return;
    const toolCallId = asString(rec.toolCallId);
    if (!toolCallId) return;
    const args = asRecord(rec.args) ?? {};
    const ctx: AgentLaunchContext = {
      subagentType: asString(args.subagent_type),
      prompt: asString(args.prompt),
      description: asString(args.description),
      runInBackground: args.run_in_background === true,
    };
    launchContext.set(toolCallId, ctx);
    const title = extractTaskTitle(ctx.prompt) || extractTaskTitle(ctx.description) || "";
    upsertMemberAt(memberKey(toolCallId), {
      profile: ctx.subagentType,
      title,
      state: "running",
      preview: [],
    });
    flushChanged();
  }

  function onToolUpdate(event: unknown): void {
    const toolCallId = processableAgentCall(event);
    if (!toolCallId) return;
    const rec = asRecord(event);
    const coerced = coercePiWebDetails(rec?.partialResult);
    if (!coerced) return;
    const { details, content } = coerced;
    const sessionId = asString(details.sessionId);
    if (sessionId) sessionMembers.set(sessionId, memberKey(toolCallId));
    const ctx = launchContext.get(toolCallId);
    upsertMemberAt(memberKey(toolCallId), {
      profile: asString(details.profile) ?? ctx?.subagentType,
      state: mapPiWebStatus(details.status),
      preview: contentPreview(content),
    });
    flushChanged();
  }

  function onToolEnd(event: unknown): void {
    const toolCallId = processableAgentCall(event);
    if (!toolCallId) return;
    const rec = asRecord(event);
    const coerced = coercePiWebDetails(rec?.result);
    if (!coerced) return;
    const { details, content } = coerced;
    const sessionId = asString(details.sessionId);
    if (sessionId) sessionMembers.set(sessionId, memberKey(toolCallId));
    const ctx = launchContext.get(toolCallId);
    const profile = asString(details.profile) ?? ctx?.subagentType;
    const title = extractTaskTitle(ctx?.prompt) || extractTaskTitle(asString(details.description) ?? ctx?.description) || "";
    const runInBackground = details.runInBackground === true || ctx?.runInBackground === true;
    if (runInBackground) {
      // 后台：保持 running，终态与 preview 由 message_end 通知驱动。
      upsertMemberAt(memberKey(toolCallId), { profile, title, state: "running", preview: [] });
      flushChanged();
      return;
    }
    upsertMemberAt(memberKey(toolCallId), {
      profile,
      title,
      state: mapPiWebStatus(details.status),
      preview: contentPreview(content),
    });
    flushChanged();
  }

  function onMessageEnd(event: unknown): void {
    const rec = asRecord(event);
    const message = asRecord(rec?.message);
    if (!message || message.customType !== PI_WEB_NOTIFICATION_CUSTOM_TYPE) return;
    const details = asRecord(message.details);
    if (!details || details.kind !== PI_WEB_SUBAGENT_KIND) return;
    const sessionId = asString(details.sessionId);
    if (!sessionId) return;
    const key = sessionMembers.get(sessionId);
    if (!key) return;
    if (!runtime.members.has(key)) return;
    upsertMemberAt(key, {
      state: mapPiWebStatus(details.status),
      preview: notificationPreview(message, details),
    });
    flushChanged();
  }

  function dispose(): void {
    launchContext.clear();
    sessionMembers.clear();
  }

  return { onToolStart, onToolUpdate, onToolEnd, onMessageEnd, dispose };
}
