/**
 * Team 团队可视化 — stock pi-web 状态与 Widget 投影（Task 4）。
 *
 * 纯文本渲染 + 极窄的 Extension UI 投影：
 * - renderStatusSummary：单行摘要（leader 数 + 各非零状态数），setStatus 常驻展示（纯文本无颜色）；
 * - renderWebWidgetLines：成员块（角色 emoji + 角色标签 + 状态 emoji + 状态 + 标题 + 最多两行 preview），
 *   任意输出行均不含 ANSI/ESC/C0/C1 控制码（stock pi-web 0.8.9 不解析 ANSI，直接透传会乱码），
 *   保持聚合给定的 Leader-first 顺序，成员块之间仅用空行分隔（末成员后不尾随空行）；
 * - projectWebWidget / clearWebWidget：仅在 ctx.mode === "rpc"（stock pi-web）时
 *   写 setStatus/setWidget；其他模式一律 no-op。
 *
 * 模块边界：只 import types.ts 的类型；不 import pi-web 或任何 pi-coding-agent
 * 运行时代码；不改写 aggregate/member 引用。emoji 与文字标签是可靠身份标识，
 * 不依赖宿主 ANSI 解析能力（0.8.9 无 ansi_up、0.8.11 的 AnsiText 也非依赖项）。
 */
import type { TeamAggregateV1, TeamMemberState, TeamMemberStatusV1, TeamRole } from "./types.ts";

/** status/widget 共享的 key（与设计规格 §11 一致）。 */
export const WEB_WIDGET_KEY = "team-status";

/** widget 每名成员最多渲染的 preview 行数（聚合经 sanitize 已 ≤ 2，此处为防御性截断）。 */
export const MAX_WIDGET_PREVIEW_LINES = 2;

/** 状态计数段固定顺序（TeamMemberState 声明顺序），保证摘要确定性。 */
const STATE_ORDER: readonly TeamMemberState[] = [
  "idle",
  "starting",
  "running",
  "completed",
  "failed",
  "stopped",
  "stale",
];

/** 角色 → emoji（用户批准；文字标签才是可靠身份标识，emoji 仅作视觉增强）。 */
const ROLE_ICONS: Record<TeamRole, string> = {
  leader: "👑",
  "deep-researcher": "🔍",
  challenger: "⚔️",
  executor: "⚙️",
  reviewer: "✅",
  other: "🤖",
};

/** 角色 → 默认标签；other 优先显示成员 agent 名（设计规格 §12「agent/profile 名」）。 */
const ROLE_LABELS: Record<TeamRole, string> = {
  leader: "Leader",
  "deep-researcher": "Researcher",
  challenger: "Challenger",
  executor: "Executor",
  reviewer: "Reviewer",
  other: "Other",
};

/** 状态 → emoji（用户批准；文字标签才是可靠身份标识）。 */
const STATE_ICONS: Record<TeamMemberState, string> = {
  idle: "⚪",
  starting: "🔵",
  running: "🟢",
  completed: "✅",
  failed: "🔴",
  stopped: "⚫",
  stale: "🟡",
};

/** 紧凑头行：`{角色emoji} {角色标签} · {状态emoji} {state}[ · {model}]`；无 model 时不追加多余分隔符。 */
function compactHeader(member: TeamMemberStatusV1): string {
  const roleSegment = `${roleIcon(member.role)} ${roleLabel(member)}`;
  const stateSegment = `${stateIcon(member.state)} ${member.state}`;
  const parts = [roleSegment, stateSegment];
  if (member.model) parts.push(member.model);
  return parts.join(" · ");
}

/** projectWebWidget/clearWebWidget 所需的最小 ctx 结构（与 ExtensionContext 结构兼容）。 */
export interface WebWidgetUi {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined, options?: { placement: "aboveEditor" | "belowEditor" }): void;
}

export interface WebWidgetContext {
  mode: string;
  ui: WebWidgetUi;
}

/**
 * 单行摘要：`◆ Team · N leader · 各非零状态计数`。
 * leader 数单独成段（leader 同时计入其状态段，与设计示例一致）；
 * 状态段按 STATE_ORDER 固定顺序只列出计数 > 0 的项，保证确定性。
 */
export function renderStatusSummary(aggregate: TeamAggregateV1): string {
  let leaderCount = 0;
  const stateCounts = new Map<TeamMemberState, number>();
  for (const member of aggregate.members) {
    if (member.role === "leader") leaderCount += 1;
    stateCounts.set(member.state, (stateCounts.get(member.state) ?? 0) + 1);
  }
  const segments = ["◆ Team"];
  if (leaderCount > 0) segments.push(`${leaderCount} leader`);
  for (const state of STATE_ORDER) {
    const count = stateCounts.get(state) ?? 0;
    if (count > 0) segments.push(`${count} ${state}`);
  }
  return segments.join(" · ");
}

/**
 * Widget 行：每名成员渲染
 *   头行 `{角色emoji} {角色标签} · {状态emoji} {state}[ · {model}]`（全程纯文本、
 *   不含 ANSI/C0/C1 控制码，model 存在时以纯文本追加，无 model 时不追加多余分隔符）
 *   标题行（若有）与最多 MAX_WIDGET_PREVIEW_LINES 行 preview（各缩进两空格）。
 * 成员块之间用空行分隔，末成员后无空行。保持聚合给定的 Leader-first 顺序。
 * `now` 参数为接口契约保留（供后续时长渲染扩展），当前渲染不含时长。
 */
export function renderWebWidgetLines(aggregate: TeamAggregateV1, now: number): string[] {
  const lines: string[] = [];
  for (const member of aggregate.members) {
    if (lines.length > 0) lines.push("");
    lines.push(compactHeader(member));
    if (member.title) lines.push(`  ${member.title}`);
    const preview = member.preview.filter((line) => line.length > 0).slice(-MAX_WIDGET_PREVIEW_LINES);
    for (const previewLine of preview) {
      lines.push(`  ${previewLine}`);
    }
  }
  return lines;
}

/**
 * 投影到 stock pi-web：仅 RPC 模式生效；禁用时清理 status 与 widget 两个面。
 * 不推断 stock pi-web 的自动展开行为（2–3 行可能自动展开，更长内容可能折叠在 trigger 后）。
 */
export function projectWebWidget(ctx: WebWidgetContext, aggregate: TeamAggregateV1, enabled: boolean): void {
  if (ctx.mode !== "rpc") return;
  if (!enabled) {
    clearWebWidget(ctx);
    return;
  }
  ctx.ui.setStatus(WEB_WIDGET_KEY, renderStatusSummary(aggregate));
  ctx.ui.setWidget(WEB_WIDGET_KEY, renderWebWidgetLines(aggregate, Date.now()), { placement: "aboveEditor" });
}

/** 清理 status 与 widget 两个 RPC 投影面；非 RPC 模式 no-op。 */
export function clearWebWidget(ctx: WebWidgetContext): void {
  if (ctx.mode !== "rpc") return;
  ctx.ui.setStatus(WEB_WIDGET_KEY, undefined);
  ctx.ui.setWidget(WEB_WIDGET_KEY, undefined);
}

function roleIcon(role: TeamRole): string {
  return ROLE_ICONS[role];
}

function stateIcon(state: TeamMemberState): string {
  return STATE_ICONS[state];
}

function roleLabel(member: TeamMemberStatusV1): string {
  if (member.role === "other" && member.agent) return member.agent;
  return ROLE_LABELS[member.role];
}
