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
  readAsyncStep,
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

function newAdapter(bus, runtime, { readAsyncStep: stepReader, now = () => NOW } = {}) {
  return createPiSubagentsAdapter({
    events: bus,
    runtime,
    now,
    onChanged: () => {},
    ...(stepReader ? { readAsyncStep: stepReader } : {}),
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

test("foreground progress and result propagate model and merge retains last known model", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(createTestBus(), runtime);
  adapter.onToolStart(toolStart("subagent", "call-model", { agent: "executor", task: "Model task" }));
  adapter.onToolUpdate(toolUpdate("subagent", "call-model", {
    runId: "run-model",
    mode: "parallel",
    progress: [{
      index: 1,
      agent: "executor",
      status: "running",
      task: "Model task",
      currentTool: "bash",
      recentOutput: ["x"],
      recentTools: [],
      toolCount: 1,
      tokens: 1,
      durationMs: 1,
      model: "gpt-5.6-sol",
    }],
    results: [],
  }));
  let member = onlyChild(runtime);
  assert.equal(member.model, "gpt-5.6-sol");

  // 后续 update 省略 model：merge 必须保留 last-known model。
  adapter.onToolUpdate(toolUpdate("subagent", "call-model", {
    runId: "run-model",
    mode: "parallel",
    progress: [{
      index: 1,
      agent: "executor",
      status: "running",
      task: "Model task",
      currentTool: "bash",
      recentOutput: ["y"],
      recentTools: [],
      toolCount: 2,
      tokens: 2,
      durationMs: 2,
    }],
    results: [],
  }));
  member = onlyChild(runtime);
  assert.equal(member.model, "gpt-5.6-sol");

  // 终态 result 也携带 model：覆盖为新值。
  adapter.onToolEnd(toolEnd("subagent", "call-model", {
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "parallel",
      runId: "run-model",
      results: [{ index: 1, agent: "executor", task: "Model task", exitCode: 0, model: "deepseek-v4-flash", usage: {} }],
    },
  }));
  member = onlyChild(runtime);
  assert.equal(member.model, "deepseek-v4-flash");
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

test("object-shaped error counts as failed; non-integer exitCode (NaN/Infinity) does not fail", () => {
  const runtime = newRuntime();
  const adapter = newAdapter(createTestBus(), runtime);
  adapter.onToolStart(toolStart("subagent", "call-oe", { agent: "executor", task: "Run" }));
  adapter.onToolEnd(toolEnd("subagent", "call-oe", {
    content: [{ type: "text", text: "done" }],
    details: {
      mode: "parallel",
      runId: "run-oe",
      results: [
        { index: 0, agent: "executor", task: "ObjErr", exitCode: 0, error: { message: "boom", code: "E_FAIL" }, usage: {} },
        { index: 1, agent: "executor", task: "NaNClean", exitCode: NaN, usage: {} },
        { index: 2, agent: "executor", task: "InfClean", exitCode: Infinity, usage: {} },
      ],
    },
  }));
  const byTitle = new Map([...runtime.members.values()].map((member) => [member.title, member]));
  assert.equal(byTitle.get("ObjErr").state, "failed");
  assert.equal(byTitle.get("NaNClean").state, "completed");
  assert.equal(byTitle.get("InfClean").state, "completed");
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

test("readAsyncStep returns sanitized agent/model/preview projection and empty projection on oversize/malformed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-status-step-"));
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "r",
      steps: [{
        index: 0,
        agent: "deep-researcher",
        label: "drivers-risk-fallback",
        model: "gpt-5.6-sol",
        currentTool: "web_search",
        recentOutput: ["line one", "line two", "line three"],
      }],
    }));
    assert.deepEqual(await readAsyncStep(dir, 0, MAX_PREVIEW_BYTES), {
      agent: "deep-researcher",
      model: "gpt-5.6-sol",
      preview: ["line two", "line three"],
    });
    // 文件超过字节上限：读前即拒绝，返回空投影（无 agent/model）。
    assert.deepEqual(await readAsyncStep(dir, 0, 8), { preview: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(await readAsyncStep(join(tmpdir(), "team-status-step-missing"), 0, MAX_PREVIEW_BYTES), { preview: [] });
});

test("async members prefer artifact step agent/model and keep last two output lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "team-status-artifact-"));
  const snapshot = {
    ...asyncSnapshot,
    runs: [{
      id: "async-run",
      kind: "workflow",
      label: "drivers-risk-fallback",
      state: "running",
      children: [
        { id: "drivers-risk-fallback", kind: "step", label: "drivers-risk-fallback", state: "running", activity: { currentTool: "web_search" } },
      ],
    }],
  };
  try {
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: "async-run",
      steps: [{
        index: 0,
        agent: "deep-researcher",
        label: "drivers-risk-fallback",
        workflowKey: "drivers-risk-fallback",
        model: "gpt-5.6-sol",
        currentTool: "web_search",
        recentOutput: ["first line", "second line", "third line"],
      }],
    }));
    const bus = createTestBus();
    installBridge(bus, { asyncSnapshot: snapshot });
    const runtime = newRuntime();
    const adapter = newAdapter(bus, runtime);
    adapter.onToolEnd(toolEnd("subagent", "call-artifact", {
      content: [{ type: "text", text: "detached" }],
      details: { mode: "workflow", runId: "async-run", asyncId: "async-run", asyncDir: dir, results: [] },
    }));
    await adapter.refreshAsync();
    const member = onlyChild(runtime);
    assert.equal(member.role, "deep-researcher");
    assert.equal(member.agent, "deep-researcher");
    assert.equal(member.model, "gpt-5.6-sol");
    assert.equal(member.title, "drivers-risk-fallback");
    assert.deepEqual(member.preview, ["second line", "third line"]);
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

test("throwing emit resolves undefined, cleans up, and allows a subsequent call", async () => {
  const bus = createTestBus();
  const originalEmit = bus.emit.bind(bus);
  let shouldThrow = true;
  bus.emit = (channel, data) => {
    if (shouldThrow && channel === SUBAGENT_RPC_REQUEST_EVENT) {
      throw new Error("emit exploded");
    }
    return originalEmit(channel, data);
  };
  const client = new SubagentsRpcClient({ events: bus });

  const first = await client.status(5000);
  assert.equal(first, undefined);
  assert.equal(bus.replyListenerCount(), 0);
  assert.equal(client.inflight, false);
  assert.equal(client.activeTimer, undefined);
  assert.equal(client.activeUnsub, undefined);
  assert.equal(client.activeSettle, undefined);

  // emit 行为恢复后，后续调用仍可正常发起（inflight/清理未卡死）。
  shouldThrow = false;
  installBridge(bus, { asyncSnapshot });
  const second = await client.status(1000);
  assert.equal(second.kind, "pi-subagents.status");
  assert.equal(bus.replyListenerCount(), 0);
});
