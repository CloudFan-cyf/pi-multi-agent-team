/**
 * Team 团队可视化 — web-widget 纯文本渲染与窄投影测试（Task 4）。
 *
 * 覆盖：单行摘要计数、widget 成员块（角色 emoji/角色标签/状态 emoji/状态/标题/最多两行 preview）、
 * 成员块之间仅空行分隔、紧凑头部含/不含 model、Web 任意输出行不含 ANSI/C0/C1 控制码、
 * RPC 模式启用投影与禁用清理、非 RPC 模式 no-op。
 * 本文件为纯 ESM（.mjs），不得使用 TS 语法；类型信息以 JSDoc typedef 记录。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearWebWidget,
  projectWebWidget,
  renderStatusSummary,
  renderWebWidgetLines,
} from "../../extensions/team-status/web-widget.ts";
import { member, NOW, SESSION_ID } from "./fixtures.mjs";

/** 组装最小 TeamAggregateV1：成员顺序由调用方显式给出（本模块不重新排序）。 */
function aggregate(members, overrides = {}) {
  return {
    sessionId: SESSION_ID,
    generatedAt: NOW,
    members,
    liveShardCount: 0,
    staleShardCount: 0,
    omittedMembers: 0,
    ...overrides,
  };
}

/**
 * Executor：title + 3 行 preview。widget 防御性截断 preview 到最多 2 行，
 * 且与 sanitize.extractPreview 语义一致取「最后两行」。
 */
function executorWithThreePreviewLines() {
  return member({
    role: "executor",
    state: "running",
    title: "Implement reducer",
    preview: ["first line", "second line", "third line"],
  });
}

/** 记录 setStatus/setWidget 调用的假 UI（statusCalls/widgetCalls 为 [key, ...args]）。 */
function fakeUi() {
  const statusCalls = [];
  const widgetCalls = [];
  return {
    statusCalls,
    widgetCalls,
    setStatus(key, text) {
      statusCalls.push([key, text]);
    },
    setWidget(key, content, options) {
      widgetCalls.push([key, content, options]);
    },
  };
}

/** 断言文本不含 ESC、C0（U+0000–U+001F）、DEL（U+007F）与 C1（U+0080–U+009F）控制码。 */
function assertNoControlChars(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    assert.ok(
      !(cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)),
      `control character U+${cp.toString(16).padStart(4, "0")} found in ${JSON.stringify(text)}`,
    );
  }
}

test("summary carries useful counts without opening the widget", () => {
  assert.equal(renderStatusSummary(aggregate([
    member({ role: "leader", state: "running" }),
    member({ role: "executor", state: "running" }),
    member({ role: "reviewer", state: "failed" }),
  ])), "◆ Team · 1 leader · 2 running · 1 failed");
});

test("status summary stays plain text with no control codes", () => {
  const summary = renderStatusSummary(aggregate([
    member({ role: "leader", state: "running" }),
    member({ role: "executor", state: "failed" }),
  ]));
  assertNoControlChars(summary);
});

test("widget renders role emoji, status emoji, title, and at most two preview lines", () => {
  const lines = renderWebWidgetLines(aggregate([executorWithThreePreviewLines()]), NOW);
  assert.deepEqual(lines, [
    "⚙️ Executor · 🟢 running",
    "  Implement reducer",
    "  second line",
    "  third line",
  ]);
});

test("widget keeps blank separators only between members", () => {
  const lines = renderWebWidgetLines(
    aggregate([
      member({ role: "leader", state: "running", title: "Lead task", preview: ["Leader preview"] }),
      member({ role: "reviewer", state: "completed", title: "Review done" }),
    ]),
    NOW,
  );
  assert.deepEqual(lines, [
    "👑 Leader · 🟢 running",
    "  Lead task",
    "  Leader preview",
    "",
    "✅ Reviewer · ✅ completed",
    "  Review done",
  ]);
});

test("widget header uses emoji and appends model with a separator", () => {
  const lines = renderWebWidgetLines(aggregate([member({ role: "executor", state: "running", model: "gpt-5.6-sol" })]), NOW);
  assert.equal(lines[0], "⚙️ Executor · 🟢 running · gpt-5.6-sol");
});

test("widget header omits model separator when absent", () => {
  const lines = renderWebWidgetLines(aggregate([member({ role: "leader", state: "running" })]), NOW);
  assert.equal(lines[0], "👑 Leader · 🟢 running");
});

test("widget role emoji mapping matches the approved palette", () => {
  const cases = [
    ["leader", "👑"],
    ["deep-researcher", "🔍"],
    ["challenger", "⚔️"],
    ["executor", "⚙️"],
    ["reviewer", "✅"],
    ["other", "🤖"],
  ];
  for (const [role, emoji] of cases) {
    const lines = renderWebWidgetLines(aggregate([member({ role, state: "running" })]), NOW);
    assert.ok(
      lines[0].startsWith(`${emoji} `),
      `role ${role} should start with ${JSON.stringify(`${emoji} `)}, got ${JSON.stringify(lines[0])}`,
    );
  }
});

test("widget status emoji mapping matches the approved palette", () => {
  const cases = [
    ["idle", "⚪"],
    ["starting", "🔵"],
    ["running", "🟢"],
    ["completed", "✅"],
    ["failed", "🔴"],
    ["stopped", "⚫"],
    ["stale", "🟡"],
  ];
  for (const [state, emoji] of cases) {
    const lines = renderWebWidgetLines(aggregate([member({ role: "executor", state })]), NOW);
    assert.ok(
      lines[0].includes(`· ${emoji} ${state}`),
      `state ${state} should render ${JSON.stringify(`· ${emoji} ${state}`)}, got ${JSON.stringify(lines[0])}`,
    );
  }
});

test("widget lines contain no ESC/C0/C1 ANSI control codes", () => {
  const lines = renderWebWidgetLines(
    aggregate([
      member({ role: "leader", state: "running", title: "Lead", model: "gpt-5.6-sol" }),
      member({ role: "executor", state: "failed", title: "Boom", preview: ["line one", "line two"] }),
      member({ role: "reviewer", state: "completed", title: "Done" }),
    ]),
    NOW,
  );
  assert.ok(lines.length > 0, "expected non-empty widget lines");
  for (const line of lines) {
    assertNoControlChars(line);
  }
});

test("enabled projection writes status and above-editor widget in RPC mode", () => {
  const ui = fakeUi();
  projectWebWidget(
    { mode: "rpc", ui },
    aggregate([member({ role: "leader", state: "running", title: "" })]),
    true,
  );
  assert.deepEqual(ui.statusCalls.at(-1), ["team-status", "◆ Team · 1 leader · 1 running"]);
  assert.deepEqual(ui.widgetCalls.at(-1), ["team-status", ["👑 Leader · 🟢 running"], { placement: "aboveEditor" }]);
});

test("disabled projection clears both RPC surfaces", () => {
  const ui = fakeUi();
  projectWebWidget({ mode: "rpc", ui }, aggregate([]), false);
  assert.deepEqual(ui.statusCalls.at(-1), ["team-status", undefined]);
  assert.deepEqual(ui.widgetCalls.at(-1), ["team-status", undefined, undefined]);
});

test("clearWebWidget clears RPC surfaces and all non-RPC modes no-op", () => {
  const rpcUi = fakeUi();
  clearWebWidget({ mode: "rpc", ui: rpcUi });
  assert.deepEqual(rpcUi.statusCalls, [["team-status", undefined]]);
  assert.deepEqual(rpcUi.widgetCalls, [["team-status", undefined, undefined]]);

  const otherUi = fakeUi();
  clearWebWidget({ mode: "tui", ui: otherUi });
  projectWebWidget({ mode: "json", ui: otherUi }, aggregate([]), true);
  projectWebWidget({ mode: "print", ui: otherUi }, aggregate([]), false);
  assert.deepEqual(otherUi.statusCalls, []);
  assert.deepEqual(otherUi.widgetCalls, []);
});
