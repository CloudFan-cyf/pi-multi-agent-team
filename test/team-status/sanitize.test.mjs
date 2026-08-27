import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPreview,
  extractTaskTitle,
  makeMemberKey,
  redactSecrets,
  roleForAgent,
  sanitizeDisplayText,
} from "../../extensions/team-status/sanitize.ts";

test("extractTaskTitle prefers the first sentence below ## 目标", () => {
  assert.equal(extractTaskTitle("## 目标\n实现跨进程状态。\n\n## 约束\n只读"), "实现跨进程状态。");
});

test("sanitizeDisplayText strips ANSI, OSC, bidi controls, and bounds output", () => {
  const input = "\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\u202E";
  assert.equal(sanitizeDisplayText(input, 7), "redlink");
});

test("redactSecrets removes common bearer and API key forms", () => {
  assert.equal(redactSecrets("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer [REDACTED]");
  assert.equal(redactSecrets("OPENAI_API_KEY=sk-secret-value"), "OPENAI_API_KEY=[REDACTED]");
});

test("extractPreview keeps only the last two non-empty bounded lines", () => {
  assert.deepEqual(extractPreview("first\n\nsecond\nthird"), ["second", "third"]);
});

test("roleForAgent maps team roles and keeps unknown agents neutral", () => {
  assert.equal(roleForAgent("executor"), "executor");
  assert.equal(roleForAgent("general-purpose"), "other");
});

test("makeMemberKey is stable and hides source ids", () => {
  const key = makeMemberKey("writer-a", "tool-secret", 2);
  assert.equal(key, makeMemberKey("writer-a", "tool-secret", 2));
  assert.equal(key.length, 64);
  assert.equal(key.includes("tool-secret"), false);
});
