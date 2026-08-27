/**
 * Team 团队可视化 — 显示文本净化、凭据脱敏、标题/preview 提取与成员 key 派生。
 *
 * 设计约束（规格 §8、§6.3）：
 * - 写盘前移除 ANSI/OSC/控制字符/双向控制符/无效 surrogate，折叠异常空白；
 * - best-effort 脱敏（Bearer、常见 key=value、sk-*、私钥头），且必须先脱敏再截断，
 *   避免截断把秘密切成两半后外泄；脱敏不是安全保证；
 * - 任务标题优先取任务包「## 目标」后首个非空句，否则取整体首个非空句；
 * - 成员 key 为确定性 SHA-256，不暴露 writer/tool/session id。
 * - 任何归一化异常都返回安全降级值（"" / []），绝不返回未处理的原始输入。
 */
import { createHash } from "node:crypto";
import { MAX_TEXT_LENGTH, type TeamRole } from "./types.ts";

// ---------- 预编译模式（模块加载时编译一次） ----------

/** OSC 超链接/标题序列：ESC ] ... BEL */
const OSC_PATTERN = /\u001b\][^\u0007]*\u0007/g;
/** ANSI CSI（SGR 等）：ESC [ 参数 中间字节 终止字节 */
const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
/** 双向文本控制符：LRM/RLM/ALM、LRE/RLE/PDF/LRO/RLO、LRI/RLI/FSI/PDI */
const BIDI_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** C0/C1 控制字符（保留 \t \n \r，交由空白折叠处理） */
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** 未配对的 surrogate（保留合法成对 emoji 等） */
const INVALID_SURROGATE_PATTERN = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** 异常空白折叠 */
const WHITESPACE_PATTERN = /\s+/g;

/** 私钥头（多行 PEM） */
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** Bearer / Basic 等认证头 */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+/gi;
/** 常见 key=value / key:value 凭据形式（api key、token、secret、password 等） */
const KEY_VALUE_PATTERN = /\b([A-Za-z0-9_-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|token|secret|password|passwd)[A-Za-z0-9_-]*)\s*[=:]\s*([^\s,;]+)/gi;
/** 独立 sk-* API key */
const SK_TOKEN_PATTERN = /\bsk-[A-Za-z0-9\-_]{8,}\b/g;

const REDACTED = "[REDACTED]";

// ---------- 文本净化与脱敏 ----------

function truncateByCodePoints(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return Array.from(text).slice(0, maxLength).join("");
}

/**
 * 单行显示文本净化：移除 ANSI/OSC/双向控制符/控制字符/无效 surrogate，
 * 折叠空白，先脱敏再按 maxLength 截断。异常时返回 ""。
 */
export function sanitizeDisplayText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : "";
  if (maxLength <= 0) return "";
  try {
    const cleaned = text
      .replace(OSC_PATTERN, "")
      .replace(ANSI_PATTERN, "")
      .replace(BIDI_PATTERN, "")
      .replace(CONTROL_PATTERN, "")
      .replace(INVALID_SURROGATE_PATTERN, "");
    const redacted = redactSecrets(cleaned);
    const collapsed = redacted.replace(WHITESPACE_PATTERN, " ").trim();
    return truncateByCodePoints(collapsed, maxLength);
  } catch {
    return "";
  }
}

/**
 * Best-effort 凭据脱敏：私钥头、Bearer 头、常见 key=value、独立 sk-*。
 * 脱敏不是安全保证。异常时返回 ""。
 */
export function redactSecrets(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  try {
    return text
      .replace(PRIVATE_KEY_PATTERN, REDACTED)
      .replace(BEARER_PATTERN, "Bearer " + REDACTED)
      .replace(KEY_VALUE_PATTERN, "$1=" + REDACTED)
      .replace(SK_TOKEN_PATTERN, REDACTED);
  } catch {
    return "";
  }
}

// ---------- 标题与 preview 提取 ----------

/** 取 collapse 后文本的首个句子（以 。！？!? 结尾；无标点则整体）。 */
function firstSentence(text: string): string {
  const collapsed = text.replace(WHITESPACE_PATTERN, " ").trim();
  if (!collapsed) return "";
  const match = collapsed.match(/^.*?[。！？!?]/);
  return match ? match[0].trim() : collapsed;
}

/**
 * 任务标题：优先取「## 目标」标题下首个非空句，否则取任务文本首个非空句；
 * 经净化后截断到 MAX_TEXT_LENGTH。异常时返回 ""。
 */
export function extractTaskTitle(task: unknown): string {
  const text = typeof task === "string" ? task : "";
  try {
    const lines = text.split(/\r?\n/);
    const headingIndex = lines.findIndex((line) => /^#{1,6}\s*目标/.test(line.trim()));
    let section = "";
    if (headingIndex >= 0) {
      const body: string[] = [];
      for (let i = headingIndex + 1; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i].trim())) break;
        body.push(lines[i]);
      }
      section = body.join("\n");
    }
    const candidate = firstSentence(section || text);
    return sanitizeDisplayText(candidate, MAX_TEXT_LENGTH);
  } catch {
    return "";
  }
}

/**
 * Preview：取最后最多两行非空显示行，每行经净化并截断到 MAX_TEXT_LENGTH。
 * 异常时返回 []。
 */
export function extractPreview(value: unknown, maxLines = 2, maxLength = MAX_TEXT_LENGTH): string[] {
  const text = typeof value === "string" ? value : "";
  try {
    return text
      .split(/\r?\n/)
      .map((line) => sanitizeDisplayText(line, maxLength))
      .filter((line) => line.length > 0)
      .slice(-maxLines);
  } catch {
    return [];
  }
}

// ---------- 角色映射与成员 key ----------

/** 精确名称 → TeamRole 映射；未知 agent/profile 一律归为 "other"。 */
const ROLE_BY_AGENT: Record<string, TeamRole> = {
  leader: "leader",
  "deep-researcher": "deep-researcher",
  challenger: "challenger",
  executor: "executor",
  reviewer: "reviewer",
};

export function roleForAgent(agent: unknown): TeamRole {
  if (typeof agent !== "string") return "other";
  return ROLE_BY_AGENT[agent.trim()] ?? "other";
}

/**
 * 确定性成员 key：sha256(writerId \0 toolCallId \0 index) 的 64 位 hex。
 * 不暴露 writer/tool/session id；同一 writer 的同一子任务在所有更新中保持稳定。
 */
export function makeMemberKey(writerId: string, toolCallId: string, index: number): string {
  return createHash("sha256").update(`${writerId}\u0000${toolCallId}\u0000${index}`).digest("hex");
}
