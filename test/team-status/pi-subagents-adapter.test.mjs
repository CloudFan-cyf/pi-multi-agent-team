/**
 * Team 团队可视化 — pi-subagents 前台/异步适配器单测（Task 6）。
 *
 * 仅使用 Pi EventBus 结构 RPC 与 pi-subagents 0.56.0 公共 result DTO 形状，
 * 不 import pi-subagents 内部实现。前台成员身份 = 父 toolCallId + progress/results
 * 数字 index；异步成员身份 = launch toolCallId + workflow 子节点遍历位置。
 * Fleet opaque key 绝不参与成员 join。
 *
 * 确定性 NOW epoch 与 fixtures 一致；RPC 超时/在飞/监听器计数用可控假 EventBus
 * 断言（subscribe-before-emit、reply/timeout/dispose 均退订、同一时刻仅一个在飞请求）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeState } from "../../extensions/team-status/reducer.ts";
import { makeMemberKey } from "../../extensions/team-status/sanitize.ts";
import {
  createPiSubagentsAdapter,
  readAsyncPreview,
  SubagentsRpcClient,
  SUBAGENT_RPC_REQUEST_EVENT,
  SUBAGENT_RPC_REPLY_PREFIX,
} from "../../extensions/team-status/pi-subagents-adapter.ts";
import { NOW, SESSION_ID } from "./fixtures.mjs";

const WRITER_ID = "adapter-writer";
const MAX_PREVIEW_BYTES = 1024 * 1024; // 1 MiB

// ---------- 真实公共 result 形状夹具（pi-subagents 0.56.0 public details） ----------

const partial = {
  runId: "foreground-run",
  mode: "parallel",
  progress: [{
    index: 1,
    agent: "executor",
    status: "running",
    task: "Implement reducer",
    currentTool: "bash",
    recentOutput: ["npm test", "7 passing"],
    recentTools: [],
    toolCount: 2,
    tokens: 120,
    durationMs: 900,
  }],
  results: [],
};

const asyncSnapshot = {
  kind: "pi-subagents.async-status-snapshot",
  version: 1,
  generatedAt: NOW,
  caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32768 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: [{ id: "async-run", kind: "workflow", label: "executor", state: "running", children: [
    { id: "implementation", kind: "step", label: "executor", state: "running", activity: { currentTool: "edit" } },
  ] }],
};

const ASYNC_DIR = join(tmpdir(), "team-status-no-such-async-dir");

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

// ---------- 可控假 EventBus（监听器计数 / 请求发射计数） ----------

function createTestBus() {
  const listeners = new Map();
  const bus = {
    requestEmits: [],
    emit(channel, data) {
      if (channel === SUBAGENT_RPC_REQUEST_EVENT) bus.requestEmits.push(data);
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on(channel, handler) {
      const arr = listeners.get(channel) ?? [];
      arr.push(handler);
      listeners.set(channel, arr);
      return () => {
        const cur = listeners.get(channel) ?? [];
        const index = cur.indexOf(handler);
        if (index >= 0) cur.splice(index, 1);
      };
    },
    replyListenerCount() {
      let total = 0;
      for (const [channel, arr] of listeners) {
        if (channel.startsWith(SUBAGENT_RPC_REPLY_PREFIX)) total += arr.length;
      }
      return total;
    },
  };
  return bus;
}

/** 安装模拟 pi-subagents RPC 桥：收到 status 请求即回包（成功信封）。 */
function installBridge(bus, data) {
  bus.on(SUBAGENT_RPC_REQUEST_EVENT, (req) => {
    bus.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${req.requestId}`, {
      version: 1,
      requestId: req.requestId,
      method: req.method,
      success: true,
      data,
    });
  });
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

function newAdapter(bus, runtime, { readAsyncPreview: previewReader, now = () => NOW } = {}) {
  return createPiSubagentsAdapter({
    events: bus,
    runtime,
    now,
    onChanged: () => {},
    ...(previewReader ? { readAsyncPreview: previewReader } : {}),
  });
}

// ---------- 前台关联 ----------

test("foreground rows use details.runId plus stable result index, not Fleet keys", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(createTestBus(), runtime);
  adapter.onToolStart(toolStart("subagent", "call-1", { agent: "executor", task: "Implement reducer" }));
  adapter.onToolUpdate(toolUpdate("subagent", "call-1", partial));
  const member = onlyChild(runtime);
  assert.equal(member.role, "executor");
  assert.equal(member.title, "Implement reducer");
  assert.deepEqual(member.preview, ["npm test", "7 passing"]);
});

test("foreground member key derives from writerId + toolCallId + numeric index, ignoring fleet keys", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(createTestBus(), runtime);
  adapter.onToolStart(toolStart("subagent", "call-1", { agent: "executor", task: "T" }));
  adapter.onToolUpdate(toolUpdate("subagent", "call-1", {
    runId: "foreground-run",
    mode: "parallel",
    progress: [{
      index: 1,
      agent: "executor",
      status: "running",
      task: "T",
      currentTool: "bash",
      recentOutput: ["x"],
      recentTools: [],
      toolCount: 1,
      tokens: 1,
      durationMs: 1,
      key: "fleet-999",
    }],
    results: [],
  }));
  const member = onlyChild(runtime);
  assert.equal(member.key, makeMemberKey(WRITER_ID, "call-1", 1));
  assert.notEqual(member.key, "fleet-999");
});

test("management calls with args.action are ignored", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(createTestBus(), runtime);
  adapter.onToolStart(toolStart("subagent", "call-m", { action: "schedule.list" }));
  adapter.onToolUpdate(toolUpdate("subagent", "call-m", partial));
  adapter.onToolEnd(toolEnd("subagent", "call-m", {
    content: [{ type: "text", text: "managed" }],
    details: { mode: "management", results: [{ index: 0, agent: "executor", task: "X", exitCode: 0, usage: {} }] },
  }));
  assert.equal(runtime.members.size, 0);
});

test("terminal results map exit/error/stopped states and always set terminalAt", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(createTestBus(), runtime);
  adapter.onToolStart(toolStart("subagent", "call-t", { agent: "executor", task: "Run" }));
  adapter.onToolEnd(toolEnd("subagent", "call-t", {
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "parallel",
      runId: "run-t",
      results: [
        { index: 0, agent: "executor", task: "Ok", exitCode: 0, usage: {} },
        { index: 1, agent: "executor", task: "Bad", exitCode: 1, usage: {} },
        { index: 2, agent: "executor", task: "Err", exitCode: 0, error: "boom", usage: {} },
        { index: 3, agent: "executor", task: "Stop", exitCode: 0, stopped: true, usage: {} },
      ],
    },
  }));
  const byTitle = new Map([...runtime.members.values()].map((member) => [member.title, member]));
  assert.equal(byTitle.get("Ok").state, "completed");
  assert.equal(byTitle.get("Bad").state, "failed");
  assert.equal(byTitle.get("Err").state, "failed");
  assert.equal(byTitle.get("Stop").state, "stopped");
  for (const member of runtime.members.values()) {
    assert.equal(typeof member.terminalAt, "number", `member ${member.title} must set terminalAt`);
  }
});

// ---------- 异步 RPC 关联 ----------

test("async launch binds details.asyncId to asyncSnapshot root id", async () => {
  const bus = createTestBus();
  installBridge(bus, { asyncSnapshot });
  const runtime = newRuntime();
  const adapter = newAdapter(bus, runtime);
  adapter.onToolEnd(toolEnd("subagent", "call-2", {
    content: [{ type: "text", text: "detached" }],
    details: { mode: "workflow", runId: "async-run", asyncId: "async-run", asyncDir: ASYNC_DIR, results: [] },
  }));
  await adapter.refreshAsync();
  assert.equal(childByTitle(runtime, "implementation").state, "running");
  assert.equal(childByTitle(runtime, "implementation").preview[0], "Running edit");
});

test("async terminal states set terminalAt", async () => {
  const terminalSnapshot = {
    ...asyncSnapshot,
    runs: [{
      id: "async-run",
      kind: "workflow",
      label: "executor",
      state: "running",
      children: [
        { id: "done-step", kind: "step", label: "executor", state: "complete", endedAt: NOW },
        { id: "fail-step", kind: "step", label: "executor", state: "failed", endedAt: NOW },
        { id: "stop-step", kind: "step", label: "executor", state: "stopped", endedAt: NOW },
      ],
    }],
  };
  const bus = createTestBus();
  installBridge(bus, { asyncSnapshot: terminalSnapshot });
  const runtime = newRuntime();
  const adapter = newAdapter(bus, runtime);
  adapter.onToolEnd(toolEnd("subagent", "call-3", {
    content: [{ type: "text", text: "detached" }],
    details: { mode: "workflow", runId: "async-run", asyncId: "async-run", asyncDir: ASYNC_DIR, results: [] },
  }));
  await adapter.refreshAsync();
  const done = childByTitle(runtime, "done-step");
  const failed = childByTitle(runtime, "fail-step");
  const stopped = childByTitle(runtime, "stop-step");
  assert.equal(done.state, "completed");
  assert.equal(failed.state, "failed");
  assert.equal(stopped.state, "stopped");
  for (const member of [done, failed, stopped]) {
    assert.equal(typeof member.terminalAt, "number");
  }
});

test("async children use stable node.id titles, falling back to label for synthetic step:N ids", async () => {
  const syntheticSnapshot = {
    ...asyncSnapshot,
    runs: [{
      id: "async-run",
      kind: "workflow",
      label: "executor",
      state: "running",
      children: [
        { id: "step:0", kind: "step", label: "reviewer", state: "running" },
      ],
    }],
  };
  const bus = createTestBus();
  installBridge(bus, { asyncSnapshot: syntheticSnapshot });
  const runtime = newRuntime();
  const adapter = newAdapter(bus, runtime);
  adapter.onToolEnd(toolEnd("subagent", "call-4", {
    content: [{ type: "text", text: "detached" }],
    details: { mode: "workflow", runId: "async-run", asyncId: "async-run", asyncDir: ASYNC_DIR, results: [] },
  }));
  await adapter.refreshAsync();
  const child = childByTitle(runtime, "reviewer");
  assert.ok(child, "synthetic step:N id should fall back to the label as title");
  assert.equal(child.state, "running");
});

// ---------- 可选 artifact preview（仅读 <asyncDir>/status.json） ----------

test("readAsyncPreview reads only <asyncDir>/status.json and applies the byte limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-status-preview-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "r",
      steps: [
        { index: 0, agent: "executor", status: "running", recentOutput: ["line one", "line two", "line three"] },
      ],
    }));
    assert.deepEqual(await readAsyncPreview(dir, 0, MAX_PREVIEW_BYTES), ["line two", "line three"]);
    // 文件超过字节上限：读前即拒绝，返回 []。
    assert.deepEqual(await readAsyncPreview(dir, 0, 8), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAsyncPreview returns [] when status.json is missing or malformed", async () => {
  assert.deepEqual(await readAsyncPreview(join(tmpdir(), "team-status-missing-dir"), 0, MAX_PREVIEW_BYTES), []);
  const dir = mkdtempSync(join(tmpdir(), "team-status-malformed-"));
  try {
    writeFileSync(join(dir, "status.json"), "not-json{{");
    assert.deepEqual(await readAsyncPreview(dir, 0, MAX_PREVIEW_BYTES), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- RPC 客户端 ----------

test("status subscribes before emitting and unsubscribes on reply", async () => {
  const bus = createTestBus();
  installBridge(bus, { asyncSnapshot });
  const client = new SubagentsRpcClient({ events: bus });
  const status = await client.status(1000);
  assert.equal(status.kind, "pi-subagents.status");
  assert.equal(status.version, 1);
  assert.ok(status.asyncSnapshot);
  assert.equal(status.asyncSnapshot.runs[0].id, "async-run");
  assert.equal(bus.replyListenerCount(), 0);
});

test("status times out, resolves undefined, and unsubscribes its reply listener", async () => {
  const bus = createTestBus();
  const client = new SubagentsRpcClient({ events: bus });
  const status = await client.status(10);
  assert.equal(status, undefined);
  assert.equal(bus.replyListenerCount(), 0);
});

test("malformed replies do not throw into the caller and still unsubscribe", async () => {
  const bus = createTestBus();
  bus.on(SUBAGENT_RPC_REQUEST_EVENT, (req) => {
    bus.emit(`${SUBAGENT_RPC_REPLY_PREFIX}${req.requestId}`, "garbage-not-an-object");
  });
  const client = new SubagentsRpcClient({ events: bus });
  const status = await client.status(50);
  assert.equal(status, undefined);
  assert.equal(bus.replyListenerCount(), 0);
});

test("only one status request is in flight at a time", async () => {
  const bus = createTestBus();
  const client = new SubagentsRpcClient({ events: bus });
  const first = client.status(200);
  const second = client.status(200);
  assert.equal(bus.requestEmits.length, 1);
  assert.equal(await second, undefined);
  assert.equal(await first, undefined);
  assert.equal(bus.replyListenerCount(), 0);
});

test("dispose unsubscribes any pending reply listener and settles the pending request", async () => {
  const bus = createTestBus();
  const client = new SubagentsRpcClient({ events: bus });
  const pending = client.status(5000);
  assert.equal(bus.replyListenerCount(), 1);
  client.dispose();
  assert.equal(bus.replyListenerCount(), 0);
  assert.equal(await pending, undefined);
});
