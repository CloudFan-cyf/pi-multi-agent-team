/**
 * Team 团队可视化 — 非抢占式 TUI overlay 生命周期测试（Task 5）。
 *
 * 用假 ctx.ui.custom() 模拟 Pi TUI 的 custom 语义：工厂同步执行、done 解析 Promise、
 * overlay 时回调 onHandle。覆盖：top-right non-capturing overlay + 立即 unfocus、
 * hide 经 done(null) 关闭并 resolve、每次 show 创建全新组件、generation 守卫、
 * RPC 模式不调用 custom、refresh 请求重绘、宽度受限且 ANSI 安全的行渲染、
 * dispose 清理引用、每个 custom Promise 都 resolve。
 * 本文件为纯 ESM（.mjs），不得使用 TS 语法。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTuiOverlayManager,
  renderTuiOverlayLines,
  TUI_OVERLAY_WIDTH,
} from "../../extensions/team-status/tui-overlay.ts";
import { TUI_MIN_COLUMNS } from "../../extensions/team-status/types.ts";
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

/** 无色主题：fg 返回纯文本（用于结构化断言）。 */
function plainTheme() {
  return { fg(_color, text) { return text; } };
}

/** 带 ANSI SGR 的主题：fg 包裹完整 SGR + 复位（用于宽度/ANSI 安全断言）。 */
function ansiTheme() {
  const codes = { accent: "36", success: "32", warning: "33", error: "31", muted: "90", text: "39" };
  return { fg(color, text) { return `\x1b[${codes[color]}m${text}\x1b[0m`; } };
}

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;
function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, "");
}
function visibleWidth(text) {
  return Array.from(stripAnsi(text)).length;
}

/**
 * 假 custom 环境：模拟 Pi TUI showExtensionCustom 语义——
 * 工厂同步调用并返回组件；done 幂等解析 Promise；overlay 时创建 handle 并回调 onHandle。
 * 记录 customCalls / doneValues / renderRequests / customPromises，并暴露
 * 最近一次 factory 产出的 component、done、handle 与 overlayOptions。
 */
function overlayHarness({ mode = "tui", getAggregate, deferFactory = false } = {}) {
  const customCalls = [];
  const doneValues = [];
  const renderRequests = [];
  const customPromises = [];
  const pendingFactories = [];
  let latestComponent = null;
  let latestDone = null;
  let handle = null;
  const theme = plainTheme();

  const tui = {
    requestRender(force) {
      renderRequests.push(force);
    },
  };

  function runFactory(factory, options, done, call) {
    const component = factory(tui, theme, {}, done);
    latestComponent = component;
    latestDone = done;
    call.component = component;
    call.done = done;
    if (options?.overlay) {
      handle = {
        unfocusCalls: 0,
        hideCalls: 0,
        unfocus() {
          this.unfocusCalls += 1;
        },
        hide() {
          this.hideCalls += 1;
        },
      };
      options.onHandle?.(handle);
    }
  }

  function custom(factory, options) {
    const promise = new Promise((resolve) => {
      let closed = false;
      const done = (result) => {
        if (closed) return;
        closed = true;
        doneValues.push(result);
        resolve(result);
      };
      const call = { factory, options, component: null, done: null };
      customCalls.push(call);
      if (deferFactory) {
        pendingFactories.push(() => runFactory(factory, options, done, call));
      } else {
        runFactory(factory, options, done, call);
      }
    });
    customPromises.push(promise);
    return promise;
  }

  function flush() {
    const pending = pendingFactories.splice(0);
    for (const run of pending) run();
    return new Promise((resolve) => setImmediate(resolve));
  }

  return {
    ctx: { mode, ui: { custom } },
    customCalls,
    doneValues,
    renderRequests,
    customPromises,
    get handle() { return handle; },
    get component() { return latestComponent; },
    get done() { return latestDone; },
    get overlayOptions() { return customCalls.at(-1)?.options.overlayOptions; },
    getAggregate: getAggregate ?? (() => aggregate([member()])),
    flush,
  };
}

/** 带标题 + 3 行 preview 的 executor（防御性截断 preview 到最多 2 行，取最后两行）。 */
function executorMember() {
  return member({
    role: "executor",
    state: "running",
    title: "Implement reducer",
    preview: ["first line", "second line", "third line"],
  });
}

test("show creates a top-right non-capturing overlay and immediately unfocuses", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  await harness.flush();
  assert.equal(harness.customCalls.length, 1);
  assert.equal(harness.customCalls[0].options.overlay, true);
  assert.equal(harness.customCalls[0].options.overlayOptions.anchor, "top-right");
  assert.equal(harness.handle.unfocusCalls, 1);
});

test("hide resolves custom through done and show creates a fresh component", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  await harness.flush();
  const first = harness.component;
  manager.hide();
  assert.equal(harness.doneValues.at(-1), null);
  manager.show(harness.ctx);
  await harness.flush();
  assert.notEqual(harness.component, first);
});

test("show is idempotent while visible: two shows before hide make one custom call", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  const first = harness.component;
  manager.show(harness.ctx); // 已可见 → 不得二次调用 custom
  await harness.flush();
  assert.equal(harness.customCalls.length, 1);
  assert.equal(harness.component, first);
  manager.hide();
  assert.equal(harness.doneValues.at(-1), null);
  manager.show(harness.ctx);
  await harness.flush();
  assert.equal(harness.customCalls.length, 2);
  assert.notEqual(harness.component, first);
});

test("show is idempotent while mounting: repeated show before deferred factory runs makes one custom call", async () => {
  const harness = overlayHarness({ deferFactory: true });
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  manager.show(harness.ctx); // 第一个 overlay 仍处于 mounting（factory 未执行）→ 不得二次调用 custom
  assert.equal(harness.customCalls.length, 1);
  await harness.flush(); // factory 此刻才执行 → component/done 可用
  const first = harness.component;
  assert.ok(first, "component should exist once the deferred factory runs");
  manager.hide();
  assert.equal(harness.doneValues.at(-1), null);
  manager.show(harness.ctx);
  await harness.flush();
  assert.equal(harness.customCalls.length, 2);
  assert.notEqual(harness.component, first);
});

test("responsive visibility hides details below 110 columns", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  await harness.flush();
  assert.equal(harness.overlayOptions.visible(TUI_MIN_COLUMNS - 1, 40), false);
  assert.equal(harness.overlayOptions.visible(TUI_MIN_COLUMNS, 40), true);
});

test("show marks overlay non-capturing and sizes the top-right card", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  await harness.flush();
  const opts = harness.customCalls[0].options.overlayOptions;
  assert.equal(opts.nonCapturing, true);
  assert.equal(opts.width, TUI_OVERLAY_WIDTH);
  assert.equal(typeof opts.maxHeight, "number");
  assert.equal(typeof opts.margin, "number");
});

test("RPC mode never calls custom", () => {
  const harness = overlayHarness({ mode: "rpc" });
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  assert.equal(harness.customCalls.length, 0);
});

test("refresh requests a render while shown and is a no-op after dispose", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  await harness.flush();
  manager.refresh();
  assert.equal(harness.renderRequests.length, 1);
  manager.dispose();
  await harness.flush();
  manager.refresh();
  assert.equal(harness.renderRequests.length, 1);
});

test("dispose resolves done and clears references after the Promise finally path", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  await harness.flush();
  manager.dispose();
  assert.equal(harness.doneValues.at(-1), null);
  await harness.flush();
  manager.refresh(); // requestRender 引用已清空 → no-op
  assert.equal(harness.renderRequests.length, 0);
  manager.hide(); // done 引用已清空 → 不再解析
  assert.equal(harness.doneValues.length, 1);
});

test("an old promise finally cannot clear a newer overlay", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  await harness.flush();
  const first = harness.component;
  manager.hide(); // 解析 gen1，但 finally 尚未运行
  manager.show(harness.ctx); // gen2，全新组件
  await harness.flush(); // gen1 的 finally 在此运行，不得清空 gen2
  assert.equal(harness.component, harness.customCalls[1].component);
  assert.notEqual(harness.component, first);
  manager.refresh();
  assert.equal(harness.renderRequests.length, 1);
  manager.hide();
  assert.equal(harness.doneValues.at(-1), null);
  assert.equal(harness.doneValues.length, 2);
});

test("every custom Promise resolves through done", async () => {
  const harness = overlayHarness();
  const manager = createTuiOverlayManager({ getAggregate: harness.getAggregate, onError: assert.fail });
  manager.show(harness.ctx);
  manager.hide();
  manager.show(harness.ctx);
  manager.hide();
  manager.show(harness.ctx);
  manager.dispose();
  await Promise.all(harness.customPromises);
  assert.deepEqual(harness.doneValues, [null, null, null]);
});

test("overlay renders icon, role, state, title, and at most two preview lines", () => {
  const lines = renderTuiOverlayLines(aggregate([executorMember()]), TUI_OVERLAY_WIDTH, plainTheme());
  assert.deepEqual(lines, [
    "› Executor · running",
    "  Implement reducer",
    "  second line",
    "  third line",
  ]);
});

test("overlay keeps blank separators only between members", () => {
  const lines = renderTuiOverlayLines(
    aggregate([
      member({ role: "leader", state: "running", title: "Lead task", preview: ["Leader preview"] }),
      member({ role: "reviewer", state: "completed", title: "Review done" }),
    ]),
    TUI_OVERLAY_WIDTH,
    plainTheme(),
  );
  assert.deepEqual(lines, [
    "◆ Leader · running",
    "  Lead task",
    "  Leader preview",
    "",
    "✓ Reviewer · completed",
    "  Review done",
  ]);
});

test("renderTuiOverlayLines bounds every line to width and closes ANSI safely", () => {
  const theme = ansiTheme();
  const lines = renderTuiOverlayLines(
    aggregate([
      member({
        role: "executor",
        state: "running",
        title: "A".repeat(200),
        preview: ["B".repeat(200), "C".repeat(200)],
      }),
    ]),
    46,
    theme,
  );
  assert.ok(lines.length >= 3, "expected header + title + preview lines");
  for (const line of lines) {
    const width = visibleWidth(line);
    assert.ok(width <= 46, `line visible width ${width} exceeds 46: ${JSON.stringify(line)}`);
  }
  // 头部行应含 ANSI 颜色，且截断后仍被主题正确复位。
  assert.ok(lines[0].includes("\x1b["), "header should carry role/state color");
  assert.equal(visibleWidth(lines[0]), visibleWidth("› Executor · running"));
});

test("zero width renders no lines", () => {
  assert.deepEqual(renderTuiOverlayLines(aggregate([executorMember()]), 0, plainTheme()), []);
});
