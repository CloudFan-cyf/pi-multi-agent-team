import test from "node:test";
import assert from "node:assert/strict";
import registerTeamExtension from "../../extensions/index.ts";

const CONTROL_EVENT = "subagent:control-event";

function createPiHarness() {
  const eventListeners = new Map();
  const lifecycleListeners = new Map();
  const sentMessages = [];

  const addListener = (map, channel, handler) => {
    const listeners = map.get(channel) ?? [];
    listeners.push(handler);
    map.set(channel, listeners);
    return () => {
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    };
  };

  const pi = {
    events: {
      on(channel, handler) {
        return addListener(eventListeners, channel, handler);
      },
      emit(channel, payload) {
        for (const handler of [...(eventListeners.get(channel) ?? [])]) handler(payload);
      },
    },
    on(event, handler) {
      addListener(lifecycleListeners, event, handler);
    },
    registerCommand() {},
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };

  async function emitLifecycle(event, payload = {}, ctx = {}) {
    for (const handler of [...(lifecycleListeners.get(event) ?? [])]) {
      await handler(payload, ctx);
    }
  }

  return { pi, sentMessages, emitLifecycle };
}

function executorTimeThreshold(overrides = {}) {
  return {
    source: "async",
    event: {
      type: "active_long_running",
      reason: "time_threshold",
      runId: "executor-run-1",
      agent: "executor",
      index: 0,
      elapsedMs: 480_000,
      message: "executor is still active but long-running",
      to: "active_long_running",
      ts: 1_000_000,
      ...overrides,
    },
  };
}

test("executor time threshold wakes the leader with checkpoint instructions", () => {
  const harness = createPiHarness();
  registerTeamExtension(harness.pi);

  harness.pi.events.emit(CONTROL_EVENT, executorTimeThreshold());

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].options.triggerTurn, true);
  assert.equal(harness.sentMessages[0].message.customType, "team-executor-soft-timeout");
  assert.match(harness.sentMessages[0].message.content, /executor-run-1/);
  assert.match(harness.sentMessages[0].message.content, /status/);
  assert.match(harness.sentMessages[0].message.content, /steer/);
  assert.match(harness.sentMessages[0].message.content, /changed files/i);
});

test("events outside the async executor time threshold do not wake the leader", () => {
  const harness = createPiHarness();
  registerTeamExtension(harness.pi);

  harness.pi.events.emit(CONTROL_EVENT, executorTimeThreshold({ agent: "reviewer" }));
  harness.pi.events.emit(CONTROL_EVENT, executorTimeThreshold({ type: "needs_attention" }));
  harness.pi.events.emit(CONTROL_EVENT, executorTimeThreshold({ reason: "tool_open_threshold" }));
  harness.pi.events.emit(CONTROL_EVENT, executorTimeThreshold({ elapsedMs: 479_999 }));
  harness.pi.events.emit(CONTROL_EVENT, { ...executorTimeThreshold(), source: "foreground" });
  harness.pi.events.emit(CONTROL_EVENT, { source: "async", event: null });

  assert.equal(harness.sentMessages.length, 0);
});

test("duplicate time-threshold events wake the leader only once per executor run", () => {
  const harness = createPiHarness();
  registerTeamExtension(harness.pi);
  const event = executorTimeThreshold();

  harness.pi.events.emit(CONTROL_EVENT, event);
  harness.pi.events.emit(CONTROL_EVENT, event);

  assert.equal(harness.sentMessages.length, 1);
});

test("session shutdown unsubscribes the soft-timeout bridge", async () => {
  const harness = createPiHarness();
  registerTeamExtension(harness.pi);

  await harness.emitLifecycle("session_shutdown", { reason: "reload" });
  harness.pi.events.emit(CONTROL_EVENT, executorTimeThreshold());

  assert.equal(harness.sentMessages.length, 0);
});
