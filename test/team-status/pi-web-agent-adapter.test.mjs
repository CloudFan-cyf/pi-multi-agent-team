/**
 * Team 团队可视化 — pi-web 内建 Agent 适配器单测（Task 7）。
 *
 * 仅使用 stock pi-web 0.8.x 公共 UI 事件形状（工具名 `Agent` 与
 * `message_end` 自定义消息 `pi-web:subagent-notification`），不 import
 * pi-web 内部实现。前台成员身份 = 父 toolCallId（子 index 固定 0）；
 * 后台成员在 tool end 报 `kind:"pi-web-subagent"` + sessionId 后保留
 * `sessionId → memberKey`，终态与 preview 由匹配 sessionId 的
 * message_end 通知驱动。
 *
 * 确定性 NOW epoch 与 fixtures 一致；所有无关/畸形事件绝不抛出且不改动既有状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeState } from "../../extensions/team-status/reducer.ts";
import { makeMemberKey } from "../../extensions/team-status/sanitize.ts";
import { createPiWebAgentAdapter } from "../../extensions/team-status/pi-web-agent-adapter.ts";
import { NOW, SESSION_ID } from "./fixtures.mjs";

const WRITER_ID = "pi-web-adapter-writer";

// ---------- 工具/消息事件夹具（与 pi-coding-agent ToolExecution*Event 结构一致） ----------

function toolStart(toolName, toolCallId, args) {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function toolUpdate(toolName, toolCallId, partialResult, args = {}) {
  return { type: "tool_execution_update", toolCallId, toolName, args, partialResult };
}

function toolEnd(toolName, toolCallId, result, isError = false) {
  return { type: "tool_execution_end", toolCallId, toolName, result, isError };
}

/** pi-web Agent 工具结束：result = { content, details }。 */
function agentToolEnd(toolCallId, details, content = []) {
  return toolEnd("Agent", toolCallId, { content, details });
}

/** pi-web 后台完成通知：message_end 自定义消息。 */
function subagentNotification(sessionId, status, previewText) {
  return {
    type: "message_end",
    message: {
      role: "custom",
      customType: "pi-web:subagent-notification",
      content: previewText,
      display: true,
      details: { kind: "pi-web-subagent", sessionId, status },
      timestamp: NOW,
    },
  };
}

// ---------- 运行期辅助 ----------

function newRuntime() {
  return createRuntimeState({ sessionId: SESSION_ID, writerId: WRITER_ID, writerPid: 12345, now: NOW });
}

function onlyChild(runtime) {
  const members = [...runtime.members.values()];
  assert.equal(members.length, 1, `expected exactly one member, got ${members.length}`);
  return members[0];
}

function childByTitle(runtime, title) {
  return [...runtime.members.values()].find((member) => member.title === title);
}

function newAdapter(runtime, onChanged = () => {}) {
  return createPiWebAgentAdapter({ runtime, now: () => NOW, onChanged });
}

// ---------- 前台/后台关联 ----------

test("Agent start creates a neutral or mapped profile member", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);
  adapter.onToolStart(toolStart("Agent", "agent-call", {
    subagent_type: "reviewer",
    prompt: "Review the visualization diff",
    description: "Review visualization",
    run_in_background: true,
  }));
  const member = onlyChild(runtime);
  assert.equal(member.role, "reviewer");
  assert.equal(member.title, "Review the visualization diff");
  assert.equal(member.key, makeMemberKey(WRITER_ID, "agent-call", 0));
});

test("unknown profile maps to other and title falls back to description", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);
  adapter.onToolStart(toolStart("Agent", "call-unknown", {
    subagent_type: "mystery-profile",
    prompt: "",
    description: "Unknown task",
    run_in_background: false,
  }));
  const member = onlyChild(runtime);
  assert.equal(member.role, "other");
  assert.equal(member.title, "Unknown task");
});

test("background tool end stays running until notification message_end", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);
  adapter.onToolEnd(agentToolEnd("agent-call", {
    kind: "pi-web-subagent",
    sessionId: "child-session",
    profile: "reviewer",
    description: "Review visualization",
    status: "running",
    runInBackground: true,
    createdAt: "2026-08-27T00:00:00.000Z",
  }));
  assert.equal(onlyChild(runtime).state, "running");
  adapter.onMessageEnd(subagentNotification("child-session", "completed", "Review passed"));
  const member = onlyChild(runtime);
  assert.equal(member.state, "completed");
  assert.equal(typeof member.terminalAt, "number");
  assert.deepEqual(member.preview, ["Review passed"]);
});

test("background flag from start args also keeps member running at tool end", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);
  adapter.onToolStart(toolStart("Agent", "bg-call", {
    subagent_type: "executor",
    prompt: "Run in background",
    description: "Background",
    run_in_background: true,
  }));
  adapter.onToolEnd(agentToolEnd("bg-call", {
    kind: "pi-web-subagent",
    sessionId: "bg-session",
    status: "running",
  }));
  assert.equal(onlyChild(runtime).state, "running");
  adapter.onMessageEnd(subagentNotification("bg-session", "failed", "Background failed"));
  const member = onlyChild(runtime);
  assert.equal(member.state, "failed");
  assert.deepEqual(member.preview, ["Background failed"]);
});

test("foreground end maps completed/failed/aborted/interrupted and extracts preview from content", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);

  adapter.onToolStart(toolStart("Agent", "fg-done", { subagent_type: "executor", prompt: "Done task" }));
  adapter.onToolEnd(agentToolEnd("fg-done", { kind: "pi-web-subagent", status: "completed" }, [
    { type: "text", text: "all done" },
  ]));

  adapter.onToolStart(toolStart("Agent", "fg-fail", { subagent_type: "executor", prompt: "Fail task" }));
  adapter.onToolEnd(agentToolEnd("fg-fail", { kind: "pi-web-subagent", status: "failed" }));

  adapter.onToolStart(toolStart("Agent", "fg-abort", { subagent_type: "executor", prompt: "Abort task" }));
  adapter.onToolEnd(agentToolEnd("fg-abort", { kind: "pi-web-subagent", status: "aborted" }));

  adapter.onToolStart(toolStart("Agent", "fg-interrupt", { subagent_type: "executor", prompt: "Interrupt task" }));
  adapter.onToolEnd(agentToolEnd("fg-interrupt", { kind: "pi-web-subagent", status: "interrupted" }));

  assert.equal(childByTitle(runtime, "Done task").state, "completed");
  assert.deepEqual(childByTitle(runtime, "Done task").preview, ["all done"]);
  assert.equal(childByTitle(runtime, "Fail task").state, "failed");
  assert.equal(childByTitle(runtime, "Abort task").state, "stopped");
  assert.equal(childByTitle(runtime, "Interrupt task").state, "stopped");
  for (const member of runtime.members.values()) {
    assert.equal(typeof member.terminalAt, "number", `member ${member.title} must set terminalAt`);
  }
});

test("tool update only accepts pi-web-subagent details and updates running preview", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);
  adapter.onToolStart(toolStart("Agent", "upd-call", { subagent_type: "executor", prompt: "Run tests" }));
  adapter.onToolUpdate(toolUpdate("Agent", "upd-call", {
    content: [{ type: "text", text: "running tests" }],
    details: { kind: "pi-web-subagent", status: "running" },
  }));
  assert.equal(onlyChild(runtime).state, "running");
  assert.deepEqual(onlyChild(runtime).preview, ["running tests"]);

  // 非 pi-web-subagent 的 update 被忽略，既有 preview 保持不变。
  adapter.onToolUpdate(toolUpdate("Agent", "upd-call", {
    content: [{ type: "text", text: "should not appear" }],
    details: { kind: "other" },
  }));
  assert.deepEqual(onlyChild(runtime).preview, ["running tests"]);
});

// ---------- 守卫与健壮性 ----------

test("unrelated tools and messages are ignored", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);
  adapter.onToolStart(toolStart("subagent", "sub-call", { agent: "executor" }));
  adapter.onToolStart(toolStart("bash", "bash-call", { command: "ls" }));
  adapter.onToolEnd(toolEnd("Agent", "wrong-kind", { content: [], details: { kind: "other" } }));
  adapter.onMessageEnd({ type: "message_end", message: { role: "assistant", content: "hi" } });
  adapter.onMessageEnd({
    type: "message_end",
    message: { role: "custom", customType: "some-other-type", content: "x", details: { kind: "pi-web-subagent", sessionId: "s", status: "completed" } },
  });
  assert.equal(runtime.members.size, 0);
});

test("malformed notification details retain the prior member", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);
  adapter.onToolEnd(agentToolEnd("agent-call", {
    kind: "pi-web-subagent",
    sessionId: "child-session",
    profile: "reviewer",
    description: "Review visualization",
    status: "running",
    runInBackground: true,
  }));
  // 畸形 details：非对象 / kind 不匹配 / sessionId 不匹配，均不改动既有 running 状态。
  adapter.onMessageEnd({
    type: "message_end",
    message: { role: "custom", customType: "pi-web:subagent-notification", details: "garbage" },
  });
  adapter.onMessageEnd({
    type: "message_end",
    message: { role: "custom", customType: "pi-web:subagent-notification", details: { kind: "other" } },
  });
  adapter.onMessageEnd({
    type: "message_end",
    message: { role: "custom", customType: "pi-web:subagent-notification", details: { kind: "pi-web-subagent", sessionId: "unknown-session", status: "completed" } },
  });
  assert.equal(onlyChild(runtime).state, "running");
});

test("onChanged fires only for real member mutations", () => {
  let changed = 0;
  const runtime = newRuntime();
  const adapter = newAdapter(runtime, () => { changed += 1; });

  adapter.onToolStart(toolStart("bash", "b-1", { command: "ls" }));
  assert.equal(changed, 0);

  adapter.onToolStart(toolStart("Agent", "a-1", { subagent_type: "executor", prompt: "T" }));
  assert.equal(changed, 1);

  adapter.onToolEnd(toolEnd("Agent", "a-1", { content: [], details: { kind: "other" } }));
  adapter.onMessageEnd({ type: "message_end", message: { role: "assistant" } });
  assert.equal(changed, 1);

  adapter.onToolEnd(agentToolEnd("a-1", { kind: "pi-web-subagent", status: "completed" }, [{ type: "text", text: "x" }]));
  assert.equal(changed, 2);
});

test("dispose clears sessionId mapping so later notification is ignored", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(runtime);
  adapter.onToolEnd(agentToolEnd("agent-call", {
    kind: "pi-web-subagent",
    sessionId: "child-session",
    profile: "reviewer",
    status: "running",
    runInBackground: true,
  }));
  adapter.dispose();
  adapter.onMessageEnd(subagentNotification("child-session", "completed", "Review passed"));
  assert.equal(onlyChild(runtime).state, "running");
});
