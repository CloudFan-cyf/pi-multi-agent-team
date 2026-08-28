/**
 * Team 团队可视化 — web-widget 纯文本渲染与窄投影测试（Task 4）。
 *
 * 覆盖：单行摘要计数、widget 成员块（图标/角色/状态/标题/最多两行 preview）、
 * 成员块之间仅空行分隔、RPC 模式启用投影与禁用清理、非 RPC 模式 no-op。
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

test("summary carries useful counts without opening the widget", () => {
  assert.equal(renderStatusSummary(aggregate([
    member({ role: "leader", state: "running" }),
    member({ role: "executor", state: "running" }),
    member({ role: "reviewer", state: "failed" }),
  ])), "◆ Team · 1 leader · 2 running · 1 failed");
});

test("widget renders icon, role, state, title, and at most two preview lines", () => {
  const lines = renderWebWidgetLines(aggregate([executorWithThreePreviewLines()]), NOW);
  assert.deepEqual(lines, [
    "\x1b[32m› Executor\x1b[0m · \x1b[32mrunning\x1b[0m",
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
    "\x1b[35m◆ Leader\x1b[0m · \x1b[32mrunning\x1b[0m",
    "  Lead task",
    "  Leader preview",
    "",
    "\x1b[34m✓ Reviewer\x1b[0m · \x1b[32mcompleted\x1b[0m",
    "  Review done",
  ]);
});

test("widget header injects bounded role/state ANSI colors and appends model", () => {
  const lines = renderWebWidgetLines(aggregate([member({ role: "executor", state: "running", model: "gpt-5.6-sol" })]), NOW);
  assert.equal(lines[0], "\x1b[32m› Executor\x1b[0m · \x1b[32mrunning\x1b[0m · gpt-5.6-sol");
});

test("widget header omits model separator when absent", () => {
  const lines = renderWebWidgetLines(aggregate([member({ role: "leader", state: "running" })]), NOW);
  assert.equal(lines[0], "\x1b[35m◆ Leader\x1b[0m · \x1b[32mrunning\x1b[0m");
});

test("widget role and state ANSI mapping matches the approved accessible palette", () => {
  const cases = [
    ["leader", "35"],
    ["deep-researcher", "36"],
    ["challenger", "33"],
    ["executor", "32"],
    ["reviewer", "34"],
    ["other", "2"],
  ];
  for (const [role, code] of cases) {
    const lines = renderWebWidgetLines(aggregate([member({ role, state: "running" })]), NOW);
    assert.ok(lines[0].startsWith(`\x1b[${code}m`), `role ${role} should use SGR ${code}, got ${JSON.stringify(lines[0])}`);
    assert.ok(lines[0].includes("\x1b[0m"), `role ${role} segment must be reset`);
  }
  const stateCases = [
    ["running", "32"],
    ["completed", "32"],
    ["failed", "31"],
    ["stale", "33"],
    ["starting", "36"],
    ["stopped", "2"],
    ["idle", "2"],
  ];
  for (const [state, code] of stateCases) {
    const lines = renderWebWidgetLines(aggregate([member({ role: "executor", state })]), NOW);
    assert.ok(lines[0].includes(`\x1b[${code}m`), `state ${state} should use SGR ${code}, got ${JSON.stringify(lines[0])}`);
    assert.equal(lines[0].split("\x1b[0m").length - 1, 2, `state ${state} header must contain exactly two resets`);
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
  assert.deepEqual(ui.widgetCalls.at(-1), ["team-status", ["\x1b[35m◆ Leader\x1b[0m · \x1b[32mrunning\x1b[0m"], { placement: "aboveEditor" }]);
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
