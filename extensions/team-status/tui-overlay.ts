/**
 * Team 团队可视化 — 非抢占式 TUI overlay 生命周期（Task 5）。
 *
 * 结构化 Pi TUI 组件契约：不 import pi-tui / pi-coding-agent 运行时，仅以最小
 * 结构类型描述 custom overlay 工厂与 handle，便于测试与窄投影。
 *
 * 生命周期要点（规格 §10.1、§10.2）：
 * - 仅 ctx.mode === "tui" 才调用 ctx.ui.custom()；RPC/其他模式一律 no-op；
 * - 工厂内保留 done 回调；onHandle 拿到 handle 后立即 unfocus()，不抢编辑器输入；
 * - hide()/dispose() 通过 done(null) 解析 custom Promise（触发宿主关闭 + 组件 dispose），
 *   绝不把 handle.hide() 作为正常关闭路径（handle.hide 移除 TUI 条目但不解析 Promise）；
 * - 每次 show() 创建全新组件，并使用单调递增 generation 守卫：
 *   旧 Promise 的 finally 仅在 generation 仍匹配时清理引用，避免清掉新 overlay；
 * - refresh() 请求重绘；所有行按给定宽度截断（颜色由 ThemeLike.fg 自行包裹与复位）。
 */
import {
  TUI_MIN_COLUMNS,
  type TeamAggregateV1,
  type TeamMemberState,
  type TeamMemberStatusV1,
  type TeamRole,
} from "./types.ts";

export type ThemeColor = "accent" | "success" | "warning" | "error" | "muted" | "text";

/** 颜色透传主题：fg 返回文本（含完整 SGR 复位）；测试与宿主可提供任意实现。 */
export interface ThemeLike {
  fg(color: ThemeColor, text: string): string;
}

/** TUI overlay 固定宽度（列），与设计规格 §10.1「约 46 列」一致。 */
export const TUI_OVERLAY_WIDTH = 46;

// ---------- 视觉映射（设计规格 §12；颜色只是增强，符号 + 文字才是可靠身份标识） ----------

const ROLE_ICONS: Record<TeamRole, string> = {
  leader: "◆",
  "deep-researcher": "⌕",
  challenger: "!",
  executor: "›",
  reviewer: "✓",
  other: "•",
};

const ROLE_LABELS: Record<TeamRole, string> = {
  leader: "Leader",
  "deep-researcher": "Researcher",
  challenger: "Challenger",
  executor: "Executor",
  reviewer: "Reviewer",
  other: "Other",
};

const ROLE_COLORS: Record<TeamRole, ThemeColor> = {
  leader: "accent",
  "deep-researcher": "text",
  challenger: "warning",
  executor: "success",
  reviewer: "accent",
  other: "muted",
};

const STATE_COLORS: Record<TeamMemberState, ThemeColor> = {
  idle: "muted",
  starting: "text",
  running: "success",
  completed: "success",
  failed: "error",
  stopped: "muted",
  stale: "warning",
};

/** 每名成员最多渲染的 preview 行数（聚合经 sanitize 已 ≤ 2，此处为防御性截断）。 */
const MAX_OVERLAY_PREVIEW_LINES = 2;

function roleIcon(role: TeamRole): string {
  return ROLE_ICONS[role];
}

function roleLabel(member: TeamMemberStatusV1): string {
  if (member.role === "other" && member.agent) return member.agent;
  return ROLE_LABELS[member.role];
}

// ---------- 宽度受限的行渲染（ANSI 安全） ----------

interface LineSegment {
  text: string;
  color?: ThemeColor;
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function truncateCodePoints(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join("");
}

/**
 * 把段拼成宽度受限的行：按段顺序贪心填充，超宽段在段内按 code point 截断。
 * 彩色段只对「完整/截断后的纯文本」调用 theme.fg，由主题自行包裹并复位，
 * 因此绝不产生被截断的 SGR 序列或未复位颜色。
 */
function renderBoundedLine(segments: LineSegment[], width: number, theme: ThemeLike): string {
  let output = "";
  let used = 0;
  for (const segment of segments) {
    if (used >= width) break;
    const remaining = width - used;
    const plain = segment.text;
    const length = codePointLength(plain);
    if (length <= remaining) {
      output += segment.color ? theme.fg(segment.color, plain) : plain;
      used += length;
    } else if (remaining > 0) {
      const truncated = truncateCodePoints(plain, remaining);
      output += segment.color ? theme.fg(segment.color, truncated) : truncated;
      used = width;
      break;
    }
  }
  return output;
}

/**
 * 渲染 TUI overlay 行：每名成员渲染
 *   头行 `{icon} {角色标签} · {state}`（图标/角色按角色色，状态按状态色）
 *   标题行（若有）与最多 MAX_OVERLAY_PREVIEW_LINES 行 preview（各缩进两空格）。
 * 成员块之间用空行分隔，末成员后无空行。保持聚合给定的 Leader-first 顺序。
 * 所有行（含彩色段）的可见 code point 数 ≤ width。
 */
export function renderTuiOverlayLines(aggregate: TeamAggregateV1, width: number, theme: ThemeLike): string[] {
  const lines: string[] = [];
  if (width <= 0) return lines;
  for (const member of aggregate.members) {
    if (lines.length > 0) lines.push("");
    lines.push(
      renderBoundedLine(
        [
          { text: `${roleIcon(member.role)} ${roleLabel(member)}`, color: ROLE_COLORS[member.role] },
          { text: " · " },
          { text: member.state, color: STATE_COLORS[member.state] },
        ],
        width,
        theme,
      ),
    );
    if (member.title) {
      lines.push(renderBoundedLine([{ text: `  ${member.title}` }], width, theme));
    }
    const preview = member.preview.filter((line) => line.length > 0).slice(-MAX_OVERLAY_PREVIEW_LINES);
    for (const previewLine of preview) {
      lines.push(renderBoundedLine([{ text: `  ${previewLine}` }], width, theme));
    }
  }
  return lines;
}

/**
 * 结构化 TUI 组件：只实现 Pi TUI Component 的结构契约（render/invalidate/dispose），
 * 不 import pi-tui 运行时。渲染通过快照函数读取最新聚合，实现刷新。
 */
export class TeamOverlayComponent {
  private readonly snapshot: () => TeamAggregateV1;
  private readonly theme: ThemeLike;

  constructor(snapshot: () => TeamAggregateV1, theme: ThemeLike) {
    this.snapshot = snapshot;
    this.theme = theme;
  }

  render(width: number): string[] {
    return renderTuiOverlayLines(this.snapshot(), width, this.theme);
  }

  invalidate(): void {}

  dispose(): void {}
}

// ---------- overlay 状态机的结构类型 ----------

export interface OverlayTuiLike {
  requestRender(force?: boolean): void;
}

export interface OverlayHandleLike {
  unfocus(): void;
}

export interface OverlayLayoutOptions {
  anchor?: string;
  width?: number;
  maxHeight?: number | string;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
  nonCapturing?: boolean;
  visible?: (termWidth: number, termHeight: number) => boolean;
}

export interface OverlayCustomOptions {
  overlay?: boolean;
  overlayOptions?: OverlayLayoutOptions;
  onHandle?: (handle: OverlayHandleLike) => void;
}

export type OverlayComponentFactory<T> = (
  tui: OverlayTuiLike,
  theme: ThemeLike,
  keybindings: unknown,
  done: (result: T) => void,
) => TeamOverlayComponent;

export interface OverlayUiLike {
  custom<T>(factory: OverlayComponentFactory<T>, options?: OverlayCustomOptions): Promise<T>;
}

export interface TuiOverlayContext {
  mode: string;
  ui: OverlayUiLike;
}

export interface TuiOverlayManagerOptions {
  getAggregate: () => TeamAggregateV1;
  onError?: (error: unknown) => void;
}

export interface TuiOverlayManager {
  show(ctx: TuiOverlayContext): void;
  refresh(): void;
  hide(): void;
  dispose(): void;
}

/**
 * 创建非抢占式 TUI overlay 管理器。show() 只在 tui 模式创建 overlay；
 * hide()/dispose() 用 done(null) 正常关闭；generation 守卫防止旧 Promise 的
 * finally 清理掉更新一次的 overlay；dispose() 同步清空所有引用。
 */
export function createTuiOverlayManager(options: TuiOverlayManagerOptions): TuiOverlayManager {
  const getAggregate = options.getAggregate;
  const onError = options.onError;

  let generation = 0;
  let done: ((result: null) => void) | null = null;
  let handle: OverlayHandleLike | null = null;
  let component: TeamOverlayComponent | null = null;
  let requestRender: (() => void) | null = null;

  function clearReferences(): void {
    done = null;
    handle = null;
    component = null;
    requestRender = null;
  }

  function resolveDone(): void {
    if (!done) return;
    const doneToCall = done;
    done = null;
    doneToCall(null);
  }

  return {
    show(ctx) {
      if (ctx.mode !== "tui") return;
      const generationAtShow = ++generation;

      const promise = ctx.ui.custom<null>(
        (tui, theme, _keybindings, doneCallback) => {
          requestRender = () => tui.requestRender();
          done = doneCallback;
          component = new TeamOverlayComponent(getAggregate, theme);
          return component;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-right",
            width: TUI_OVERLAY_WIDTH,
            maxHeight: 24,
            margin: 1,
            nonCapturing: true,
            visible: (termWidth) => termWidth >= TUI_MIN_COLUMNS,
          },
          onHandle: (overlayHandle) => {
            handle = overlayHandle;
            overlayHandle.unfocus();
          },
        },
      );

      promise
        .catch(onError ?? (() => {}))
        .finally(() => {
          if (generation === generationAtShow) clearReferences();
        });
    },

    refresh() {
      requestRender?.();
    },

    hide() {
      resolveDone();
    },

    dispose() {
      generation += 1;
      resolveDone();
      clearReferences();
    },
  };
}
