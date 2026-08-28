# Team 团队可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 `pi-subagents`、`pi-mono` 或 `pi-web` 的前提下，为 Team 和其他 subagent 提供 TUI 右侧 overlay 与 stock pi-web Extension Widget 的跨进程实时状态视图。

**Architecture:** 当前父 Pi 进程从 `subagent`/`Agent` 工具事件和 pi-subagents 公共 RPC 归并本地成员，并把有界、净化后的 `TeamRuntimeShardV1` 原子写入 `getAgentDir()/team-status/v1/`。每个宿主进程独立写 shard；TUI 与 pi-web 扩展实例轮询聚合当前 session namespace，再分别投影到非模态 overlay 和 `setStatus`/`setWidget`。

**Tech Stack:** TypeScript、Pi Extension API 0.84.2、Node.js 22 built-in test runner、pi-subagents RPC v1、stock pi-web 0.8.x Extension UI protocol。

**Spec:** `docs/superpowers/specs/2026-08-27-team-visualization-design.md`

## Global Constraints

- 只修改 `pi-multi-agent-team`；不得修改或 patch `pi-subagents`、`pi-mono`、`pi-web`。
- 兼容基线：`@earendil-works/pi-coding-agent` 0.84.x、`pi-subagents` 0.56.x、stock `@agegr/pi-web` 0.8.x、Node.js 22。
- Web 只能使用 `ctx.ui.setStatus()` 与 `ctx.ui.setWidget()`；不得依赖 pi-web React/DOM 内部模块。
- 每个 shard 最多 16 名成员、最多 32 KiB；`agent` 最多 96 字符，`title`/每行 `preview` 最多 160 字符，preview 最多 2 行。
- 不保存 thinking、完整 prompt、完整 result、敏感工具参数或凭据；best-effort 脱敏不是安全边界。
- Leader 始终置顶；terminal 状态保留 30 秒；Team heartbeat 15 秒后 stale、60 秒后忽略。
- 不使用 Fleet opaque key 关联工具事件；foreground 使用工具事件，async 使用 `runId`/`asyncId` 对应 `asyncSnapshot` node id。
- Overlay 不抢焦点；低于 110 列只显示单行 status；RPC 模式不得调用 overlay。
- 每项任务遵循 red-green-refactor，并在 fresh reviewer 通过后才进入下一项。

## File Map

### 新增生产文件

- `extensions/team-status/types.ts`：版本化 DTO、常量、角色和状态 guard。
- `extensions/team-status/sanitize.ts`：标题/preview 提取、控制字符清理和凭据脱敏。
- `extensions/team-status/reducer.ts`：本地成员状态与跨 shard 聚合。
- `extensions/team-status/store.ts`：session namespace、原子 shard I/O、校验和有界 GC。
- `extensions/team-status/web-widget.ts`：纯文本 status/widget 渲染与 RPC 投影。
- `extensions/team-status/tui-overlay.ts`：TUI 行渲染、Component 和 overlay 生命周期。
- `extensions/team-status/pi-subagents-adapter.ts`：`subagent` 工具事件、RPC client、asyncSnapshot/artifact preview 关联。
- `extensions/team-status/pi-web-agent-adapter.ts`：pi-web `Agent` 与 background completion notification 关联。
- `extensions/team-status/controller.ts`：session 生命周期、writer/observer、timer、聚合与 UI 调度。

### 修改文件

- `extensions/index.ts`：注册 controller，并在 `/team` 成功后激活 Leader。
- `package.json`：测试/typecheck scripts 与开发依赖。
- `README.md`：使用说明、Web 限制和安全说明。
- `docs/superpowers/specs/2026-08-27-team-visualization-design.md`：记录 overlay 正常关闭必须调用 `done()` 的 API 修正。

### 新增测试与验证文件

- `tsconfig.json`
- `test/team-status/sanitize.test.mjs`
- `test/team-status/reducer.test.mjs`
- `test/team-status/store.test.mjs`
- `test/team-status/web-widget.test.mjs`
- `test/team-status/tui-overlay.test.mjs`
- `test/team-status/pi-subagents-adapter.test.mjs`
- `test/team-status/pi-web-agent-adapter.test.mjs`
- `test/team-status/controller.test.mjs`
- `test/team-status/fixtures.mjs`
- `scripts/write-team-status-fixture.mjs`
- `docs/team-visualization-validation.md`

---

### Task 1: Test Harness, Versioned Types, and Sanitization

**Files:**
- Modify: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `extensions/team-status/types.ts`
- Create: `extensions/team-status/sanitize.ts`
- Create: `test/team-status/fixtures.mjs`
- Create: `test/team-status/sanitize.test.mjs`

**Interfaces:**
- Consumes: Node.js 22, `node:crypto`.
- Produces:
  - `TeamRole`, `TeamMemberState`, `PanelMode`, `TeamMemberStatusV1`, `TeamRuntimeShardV1`, `TeamAggregateV1`.
  - `TEAM_STATUS_KIND`, `TEAM_STATUS_VERSION`, `MAX_MEMBERS`, `MAX_SHARD_BYTES`, `TERMINAL_RETENTION_MS`, `STALE_AFTER_MS`, `IGNORE_AFTER_MS`.
  - `sanitizeDisplayText(value, maxLength)`, `redactSecrets(value)`, `extractTaskTitle(task)`, `extractPreview(value)`, `roleForAgent(agent)`, `makeMemberKey(writerId, toolCallId, index)`.

- [ ] **Step 1: Add the test and typecheck toolchain**

Add these fields to `package.json` and run `npm install` so `package-lock.json` records exact resolutions:

```json
{
  "scripts": {
    "test": "node --experimental-strip-types --test test/team-status",
    "test:team-status": "node --experimental-strip-types --test test/team-status",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "0.84.2",
    "@types/node": "^22.18.0",
    "typescript": "^5.9.2"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["extensions/**/*.ts"]
}
```

- [ ] **Step 2: Write failing sanitization and identity tests**

Create `test/team-status/sanitize.test.mjs` with concrete assertions:

```js
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
```

- [ ] **Step 3: Run the test and confirm red**

Run: `node --experimental-strip-types --test --test-name-pattern="sanitize|extract|roleForAgent|makeMemberKey" test/team-status/sanitize.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extensions/team-status/sanitize.ts`.

- [ ] **Step 4: Implement the DTOs and sanitization boundary**

Create `types.ts` with the exact version/constants and interfaces from the approved spec:

```ts
export const TEAM_STATUS_KIND = "pi-multi-agent-team.runtime-shard" as const;
export const TEAM_STATUS_VERSION = 1 as const;
export const MAX_MEMBERS = 16;
export const MAX_SHARD_BYTES = 32 * 1024;
export const MAX_AGENT_LENGTH = 96;
export const MAX_TEXT_LENGTH = 160;
export const TERMINAL_RETENTION_MS = 30_000;
export const STALE_AFTER_MS = 15_000;
export const IGNORE_AFTER_MS = 60_000;
export const ACTIVE_HEARTBEAT_MS = 2_000;
export const IDLE_HEARTBEAT_MS = 5_000;
export const OBSERVER_POLL_MS = 1_000;
export const TUI_MIN_COLUMNS = 110;

export type TeamRole = "leader" | "deep-researcher" | "challenger" | "executor" | "reviewer" | "other";
export type TeamMemberState = "idle" | "starting" | "running" | "completed" | "failed" | "stopped" | "stale";
export type PanelMode = "auto" | "show" | "hide";

export interface TeamMemberStatusV1 {
  key: string;
  role: TeamRole;
  agent?: string;
  title: string;
  preview: string[];
  state: TeamMemberState;
  startedAt?: number;
  updatedAt: number;
  terminalAt?: number;
}

export interface TeamRuntimeShardV1 {
  kind: typeof TEAM_STATUS_KIND;
  version: typeof TEAM_STATUS_VERSION;
  sessionId: string;
  sessionFile?: string;
  writerId: string;
  writerPid: number;
  heartbeatAt: number;
  activatedAt: number;
  members: TeamMemberStatusV1[];
}

export interface TeamAggregateV1 {
  sessionId: string;
  generatedAt: number;
  members: TeamMemberStatusV1[];
  liveShardCount: number;
  staleShardCount: number;
  omittedMembers: number;
}
```

Implement `sanitize.ts` with precompiled ANSI/OSC/bidi patterns, deterministic SHA-256 keys, exact-name role mapping, and secret replacement before truncation. Never return raw input when normalization throws.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run test:team-status && npm run typecheck`  
Expected: all sanitization tests PASS; TypeScript exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json extensions/team-status/types.ts extensions/team-status/sanitize.ts test/team-status/fixtures.mjs test/team-status/sanitize.test.mjs
git commit -m "test(team): add visualization contracts and sanitization"
```

---

### Task 2: Local State Reducer and Multi-Writer Aggregation

**Files:**
- Create: `extensions/team-status/reducer.ts`
- Create: `test/team-status/reducer.test.mjs`

**Interfaces:**
- Consumes: Task 1 DTOs and `makeMemberKey()`.
- Produces:
  - `TeamRuntimeState`.
  - `createRuntimeState(input)`, `activateLeader(state, input)`, `upsertMember(state, member)`, `removeMember(state, key)`, `toRuntimeShard(state, now)`, `aggregateRuntimeShards(shards, sessionId, now)`.

- [ ] **Step 1: Write reducer tests for ordering, liveness, and retention**

Create tests using fixed epoch `NOW = 1_800_000_000_000`:

```js
test("aggregate pins the newest leader and preserves same-role concurrent tasks", () => {
  const aggregate = aggregateRuntimeShards([
    shard({ writerId: "a", heartbeatAt: NOW, members: [leader("a", NOW - 10), executor("a-1", NOW - 20)] }),
    shard({ writerId: "b", heartbeatAt: NOW, members: [leader("b", NOW), executor("b-1", NOW - 5)] }),
  ], SESSION_ID, NOW);
  assert.deepEqual(aggregate.members.map((member) => member.key), ["leader-b", "b-1", "a-1"]);
});

test("aggregate marks 15-60 second shards stale and ignores older shards", () => {
  const aggregate = aggregateRuntimeShards([
    shard({ writerId: "stale", heartbeatAt: NOW - 20_000, members: [executor("stale-child", NOW - 20_000)] }),
    shard({ writerId: "dead", heartbeatAt: NOW - 61_000, members: [executor("dead-child", NOW - 61_000)] }),
  ], SESSION_ID, NOW);
  assert.equal(aggregate.members[0].state, "stale");
  assert.equal(aggregate.members.some((member) => member.key === "dead-child"), false);
});

test("terminal members remain for 30 seconds only", () => {
  const recent = completed("recent", NOW - 29_999);
  const expired = completed("expired", NOW - 30_001);
  const aggregate = aggregateRuntimeShards([shard({ heartbeatAt: NOW, members: [recent, expired] })], SESSION_ID, NOW);
  assert.deepEqual(aggregate.members.map((member) => member.key), ["recent"]);
});
```

Also assert session mismatch rejection, active-before-terminal ordering, start-time tie breaking, 16-member cap, and `omittedMembers`.

- [ ] **Step 2: Run reducer tests and confirm red**

Run: `node --experimental-strip-types --test test/team-status/reducer.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `reducer.ts`.

- [ ] **Step 3: Implement pure reducer functions**

Use an in-memory map and no I/O:

```ts
export interface TeamRuntimeState {
  sessionId: string;
  sessionFile?: string;
  writerId: string;
  writerPid: number;
  activatedAt: number;
  heartbeatAt: number;
  members: Map<string, TeamMemberStatusV1>;
}

export function upsertMember(state: TeamRuntimeState, member: TeamMemberStatusV1): void {
  const current = state.members.get(member.key);
  if (!current || member.updatedAt >= current.updatedAt) state.members.set(member.key, member);
}
```

`aggregateRuntimeShards()` must validate `sessionId`, classify shard age, clone stale members with `state: "stale"`, dedupe Leader by newest `updatedAt`, filter expired terminal members, and return no more than 16 members.

- [ ] **Step 4: Run focused and full tests**

Run: `node --experimental-strip-types --test test/team-status/reducer.test.mjs && npm test && npm run typecheck`  
Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add extensions/team-status/reducer.ts test/team-status/reducer.test.mjs
git commit -m "feat(team): aggregate visualization member state"
```

---

### Task 3: Atomic Cross-Process Shard Store

**Files:**
- Create: `extensions/team-status/store.ts`
- Create: `test/team-status/store.test.mjs`

**Interfaces:**
- Consumes: `TeamRuntimeShardV1`, constants, `aggregateRuntimeShards()`.
- Produces:
  - `sessionNamespace(agentDir, sessionId): string`.
  - `parseRuntimeShard(value, expectedSessionId): TeamRuntimeShardV1 | undefined`.
  - `TeamShardStore.write(shard)`, `.read(sessionId)`, `.remove(sessionId, writerId)`, `.gc()`.

- [ ] **Step 1: Write real-filesystem tests in an isolated temp directory**

Use `mkdtemp()` and clean in `t.after()`:

```js
test("sessionNamespace is absolute, stable, and does not expose session id", () => {
  const dir = sessionNamespace(agentDir, "session-secret");
  assert.equal(path.isAbsolute(dir), true);
  assert.equal(dir.includes("session-secret"), false);
  assert.equal(dir, sessionNamespace(agentDir, "session-secret"));
});

test("write uses a bounded valid shard and read rejects another session", async () => {
  await store.write(shard({ sessionId: "one", writerId: "writer-a" }));
  assert.equal((await store.read("one")).length, 1);
  assert.equal((await store.read("two")).length, 0);
});

test("a failed replacement never exposes partial JSON", async () => {
  const failingOps = failFirstRenameWith("EPERM");
  const retryingStore = new TeamShardStore({ agentDir, ops: failingOps, now: () => NOW, randomUUID: sequenceUuid() });
  await retryingStore.write(shard({ writerId: "writer-a", heartbeatAt: NOW }));
  assert.equal((await retryingStore.read(SESSION_ID))[0].heartbeatAt, NOW);
});
```

Add tests for Unix mode requests, unknown version/kind, malformed JSON, >32 KiB rejection, stale `.tmp` cleanup, 24-hour shard cleanup, and fixed per-run GC scan cap.

- [ ] **Step 2: Run store tests and confirm red**

Run: `node --experimental-strip-types --test test/team-status/store.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `store.ts`.

- [ ] **Step 3: Implement namespace, validation, atomic replace, and GC**

Use the exact base layout:

```ts
export function sessionNamespace(agentDir: string, sessionId: string): string {
  const digest = createHash("sha256").update(`pi-multi-agent-team:v1:${sessionId}`).digest("hex");
  return join(resolve(agentDir), "team-status", "v1", digest);
}
```

For each write: serialize and check bytes, `mkdir(..., { recursive: true, mode: 0o700 })`, write a unique same-directory `.tmp` with mode `0o600`, then rename. On replacement errors `EEXIST`/`EPERM`/`EACCES`, move the previous target to a unique backup, rename the complete temp file into place, restore the backup if the second rename fails, and remove the backup after success. `read()` catches parse/read races and leaves last-snapshot retention to the controller.

- [ ] **Step 4: Run store tests repeatedly to expose file races**

Run: `node --experimental-strip-types --test --test-reporter=spec test/team-status/store.test.mjs && node --experimental-strip-types --test test/team-status/store.test.mjs && npm run typecheck`  
Expected: all three commands exit 0; no `.tmp` or `.bak` remains under the test directory.

- [ ] **Step 5: Commit**

```bash
git add extensions/team-status/store.ts test/team-status/store.test.mjs
git commit -m "feat(team): persist atomic visualization shards"
```

---

### Task 4: Web Status and Widget Projection

**Files:**
- Create: `extensions/team-status/web-widget.ts`
- Create: `test/team-status/web-widget.test.mjs`

**Interfaces:**
- Consumes: `TeamAggregateV1`.
- Produces: `renderStatusSummary(aggregate)`, `renderWebWidgetLines(aggregate, now)`, `projectWebWidget(ctx, aggregate, enabled)`, `clearWebWidget(ctx)`.

- [ ] **Step 1: Write exact rendering tests**

```js
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
    "› Executor · running",
    "  Implement reducer",
    "  second line",
    "  third line",
  ]);
});

test("disabled projection clears both RPC surfaces", () => {
  const ui = fakeUi();
  projectWebWidget({ mode: "rpc", ui }, aggregate([]), false);
  assert.deepEqual(ui.statusCalls.at(-1), ["team-status", undefined]);
  assert.deepEqual(ui.widgetCalls.at(-1), ["team-status", undefined, undefined]);
});
```

- [ ] **Step 2: Run the Web renderer test and confirm red**

Run: `node --experimental-strip-types --test test/team-status/web-widget.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `web-widget.ts`.

- [ ] **Step 3: Implement plain-text-first rendering**

Map every role to both icon and label, keep blank separators only between members, and cap output from the already bounded aggregate. `projectWebWidget()` must no-op outside RPC mode, call `setStatus("team-status", ...)`, and call:

```ts
ctx.ui.setWidget("team-status", lines, { placement: "aboveEditor" });
```

Do not infer whether stock pi-web will auto-expand; 2–3 lines may auto-expand and longer content may remain behind the trigger.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --experimental-strip-types --test test/team-status/web-widget.test.mjs && npm test && npm run typecheck`  
Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add extensions/team-status/web-widget.ts test/team-status/web-widget.test.mjs
git commit -m "feat(team): render stock pi-web status widget"
```

---

### Task 5: Non-Capturing TUI Overlay Lifecycle

**Files:**
- Create: `extensions/team-status/tui-overlay.ts`
- Create: `test/team-status/tui-overlay.test.mjs`
- Modify: `docs/superpowers/specs/2026-08-27-team-visualization-design.md`

**Interfaces:**
- Consumes: `TeamAggregateV1`, `PanelMode`, `TUI_MIN_COLUMNS`.
- Produces: `ThemeLike` (`fg(color, text): string`), `renderTuiOverlayLines(aggregate, width, theme)`, `TeamOverlayComponent`, `createTuiOverlayManager(options)` with `.show(ctx)`, `.refresh()`, `.hide()`, `.dispose()`.

- [ ] **Step 1: Write lifecycle tests with a fake `ctx.ui.custom()`**

```js
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
  manager.show(ctx);
  await flush();
  const first = harness.component;
  manager.hide();
  assert.equal(harness.doneValues.at(-1), null);
  manager.show(ctx);
  await flush();
  assert.notEqual(harness.component, first);
});

test("responsive visibility hides details below 110 columns", () => {
  assert.equal(harness.overlayOptions.visible(109, 40), false);
  assert.equal(harness.overlayOptions.visible(110, 40), true);
});
```

Also assert RPC mode never calls `custom`, refresh requests render, width 46 lines are truncated safely, and dispose clears references after the Promise `finally` path.

- [ ] **Step 2: Run overlay tests and confirm red**

Run: `node --experimental-strip-types --test test/team-status/tui-overlay.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tui-overlay.ts`.

- [ ] **Step 3: Implement the structural TUI component and close contract**

The component needs only Pi TUI's structural contract, so no runtime `pi-tui` import is required:

```ts
export interface ThemeLike {
  fg(color: "accent" | "success" | "warning" | "error" | "muted" | "text", text: string): string;
}

export class TeamOverlayComponent {
  private readonly snapshot: () => TeamAggregateV1;
  private readonly theme: ThemeLike;

  constructor(snapshot: () => TeamAggregateV1, theme: ThemeLike) {
    this.snapshot = snapshot;
    this.theme = theme;
  }

  render(width: number): string[] { return renderTuiOverlayLines(this.snapshot(), width, this.theme); }
  invalidate(): void {}
  dispose(): void {}
}
```

In `show()`, retain the factory's `done` callback and call `onHandle(handle) { handle.unfocus(); }`. In `hide()`/`dispose()`, call `done(null)` rather than `handle.hide()`: source inspection shows `handle.hide()` removes the TUI entry but does not resolve the Promise returned by `ctx.ui.custom()`. Give each `show()` a monotonically increasing generation and let `.finally()` clear references only when its generation still matches, so closing an old overlay cannot erase a newly shown one. Attach `.catch(onError).finally(...)` to the fire-and-forget Promise.

- [ ] **Step 4: Run overlay tests and the full suite**

Run: `node --experimental-strip-types --test test/team-status/tui-overlay.test.mjs && npm test && npm run typecheck`  
Expected: all commands exit 0; the test confirms every custom Promise resolves.

- [ ] **Step 5: Commit**

```bash
git add extensions/team-status/tui-overlay.ts test/team-status/tui-overlay.test.mjs docs/superpowers/specs/2026-08-27-team-visualization-design.md
git commit -m "feat(team): add non-capturing TUI team overlay"
```

---

### Task 6: pi-subagents Foreground and Async Adapter

**Files:**
- Create: `extensions/team-status/pi-subagents-adapter.ts`
- Create: `test/team-status/pi-subagents-adapter.test.mjs`

**Interfaces:**
- Consumes: Task 1 sanitizers, Task 2 runtime state, Pi `EventBus` structural API.
- Produces:
  - `SubagentsStatusV1` with optional `asyncSnapshot` and `fleet` public projections.
  - `SubagentsRpcClient.status(timeoutMs): Promise<SubagentsStatusV1 | undefined>`.
  - `readAsyncPreview(asyncDir, childIndex, maxBytes): Promise<string[]>`, restricted to `<asyncDir>/status.json`.
  - `createPiSubagentsAdapter({ events, runtime, now, onChanged, readAsyncPreview? })`.
  - adapter methods `.onToolStart(event)`, `.onToolUpdate(event)`, `.onToolEnd(event)`, `.refreshAsync()`, `.dispose()`.

- [ ] **Step 1: Write fixtures for real public result shapes**

Use guarded fixture objects matching pi-subagents 0.56.0 public details:

```js
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
```

- [ ] **Step 2: Write red tests for foreground correlation and async RPC**

Assert:

```js
test("foreground rows use details.runId plus stable result index, not Fleet keys", () => {
  adapter.onToolStart(toolStart("subagent", "call-1", { agent: "executor", task: "Implement reducer" }));
  adapter.onToolUpdate(toolUpdate("subagent", "call-1", partial));
  const member = onlyChild(runtime);
  assert.equal(member.role, "executor");
  assert.equal(member.title, "Implement reducer");
  assert.deepEqual(member.preview, ["npm test", "7 passing"]);
});

test("async launch binds details.asyncId to asyncSnapshot root id", async () => {
  adapter.onToolEnd(toolEnd("subagent", "call-2", {
    content: [{ type: "text", text: "detached" }],
    details: { mode: "workflow", runId: "async-run", asyncId: "async-run", asyncDir: ASYNC_DIR, results: [] },
  }));
  await adapter.refreshAsync();
  assert.equal(childByTitle(runtime, "implementation").state, "running");
  assert.equal(childByTitle(runtime, "implementation").preview[0], "Running edit");
});
```

Also assert `fleet.key` is ignored, RPC timeout unsubscribes its reply listener, malformed replies do not throw into the caller, terminal results map exit/error states, and `status.json` preview reads only `<asyncDir>/status.json` with a byte limit.

- [ ] **Step 3: Run adapter tests and confirm red**

Run: `node --experimental-strip-types --test test/team-status/pi-subagents-adapter.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `pi-subagents-adapter.ts`.

- [ ] **Step 4: Implement the RPC client and guarded detail parsers**

The RPC client must create a unique request id, subscribe before emitting, unsubscribe on reply/timeout, and never keep more than one in-flight status request:

```ts
this.events.emit("subagents:rpc:v1:request", {
  version: 1,
  requestId,
  method: "status",
  params: {},
});
```

Ignore management calls where `args.action` is present. Foreground `progress[]`/`results[]` use their numeric `index`; title comes from `task`, preview from `recentOutput` then `finalOutput` then safe current-tool text. Async roots bind by exact `asyncId`; workflow children use traversal position for `childIndex`, stable `node.id` for the displayed title when it is not `step:N`, and optional bounded `status.json` recent output. The artifact reader checks size before reading, accepts at most 1 MiB, reads only the literal `status.json` child of the package-provided `asyncDir`, and ignores path-like node ids. Never use `fleet.entries[].key` for member identity.

- [ ] **Step 5: Run adapter and regression tests**

Run: `node --experimental-strip-types --test test/team-status/pi-subagents-adapter.test.mjs && npm test && npm run typecheck`  
Expected: all commands exit 0; listener-count assertions return to zero after timeout and dispose.

- [ ] **Step 6: Commit**

```bash
git add extensions/team-status/pi-subagents-adapter.ts test/team-status/pi-subagents-adapter.test.mjs
git commit -m "feat(team): observe pi-subagents execution state"
```

---

### Task 7: pi-web Native Agent Adapter

**Files:**
- Create: `extensions/team-status/pi-web-agent-adapter.ts`
- Create: `test/team-status/pi-web-agent-adapter.test.mjs`

**Interfaces:**
- Consumes: runtime state and sanitizers.
- Produces: `createPiWebAgentAdapter({ runtime, now, onChanged })` with `.onToolStart()`, `.onToolUpdate()`, `.onToolEnd()`, `.onMessageEnd()`, `.dispose()`.

- [ ] **Step 1: Write red tests using pi-web 0.8.x public UI details**

```js
test("Agent start creates a neutral or mapped profile member", () => {
  adapter.onToolStart(toolStart("Agent", "agent-call", {
    subagent_type: "reviewer",
    prompt: "Review the visualization diff",
    description: "Review visualization",
    run_in_background: true,
  }));
  assert.equal(onlyChild(runtime).role, "reviewer");
  assert.equal(onlyChild(runtime).title, "Review the visualization diff");
});

test("background tool end stays running until notification message_end", () => {
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
  assert.equal(onlyChild(runtime).state, "completed");
  assert.deepEqual(onlyChild(runtime).preview, ["Review passed"]);
});
```

Also assert unrelated tools/messages are ignored, failed/aborted/interrupted map correctly, and malformed notification details retain the prior member.

- [ ] **Step 2: Run the adapter test and confirm red**

Run: `node --experimental-strip-types --test test/team-status/pi-web-agent-adapter.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `pi-web-agent-adapter.ts`.

- [ ] **Step 3: Implement guarded `Agent` and custom-message parsing**

Use `toolCallId` for the initial member and keep `sessionId → memberKey` only after details report `kind: "pi-web-subagent"`. Foreground end preview comes from result content. Background completion comes from a `message_end` custom message where `customType === "pi-web:subagent-notification"` and `details.kind === "pi-web-subagent"`; do not call pi-web HTTP routes or import pi-web modules.

- [ ] **Step 4: Run tests and typecheck**

Run: `node --experimental-strip-types --test test/team-status/pi-web-agent-adapter.test.mjs && npm test && npm run typecheck`  
Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add extensions/team-status/pi-web-agent-adapter.ts test/team-status/pi-web-agent-adapter.test.mjs
git commit -m "feat(team): observe pi-web native agents"
```

---

### Task 8: Session Controller, `/team-panel`, and Existing `/team` Integration

**Files:**
- Create: `extensions/team-status/controller.ts`
- Create: `test/team-status/controller.test.mjs`
- Modify: `extensions/index.ts:1-25,204-253,517`

**Interfaces:**
- Consumes: all previous production modules, `ExtensionAPI`, `ExtensionContext`, `getAgentDir()` supplied by `index.ts`.
- Produces:
  - `TeamStatusControllerDeps` with `agentDir`, optional `now`, `randomUUID`, `timers`, `storeFactory`, and `onDiagnostic` injections.
  - `registerTeamStatus(pi, deps: TeamStatusControllerDeps)`.
  - returned handle `{ activateTeam(ctx, title?): void; dispose(): Promise<void> }`.
  - `/team-panel show|hide|auto`.

- [ ] **Step 1: Write controller lifecycle tests before registration code**

Create a fake Pi API that records commands and event handlers, plus a fake clock/timer scheduler. Assert:

```js
test("factory registration starts no timers before session_start", () => {
  registerTeamStatus(pi, deps);
  assert.equal(clock.activeTimerCount(), 0);
});

test("session_start polls once per second and session_shutdown clears every surface", async () => {
  registerTeamStatus(pi, deps);
  await pi.emit("session_start", { reason: "startup" }, rpcContext());
  assert.equal(clock.activeTimerCount(), 1);
  await clock.tickAsync(1_000);
  assert.equal(store.readCalls.length, 1);
  await pi.emit("session_shutdown", { reason: "switch" }, rpcContext());
  assert.equal(clock.activeTimerCount(), 0);
  assert.deepEqual(ui.statusCalls.at(-1), ["team-status", undefined]);
  assert.deepEqual(ui.widgetCalls.at(-1), ["team-status", undefined, undefined]);
});

test("an observed local dispatch promotes observer to writer", async () => {
  await startSession();
  await pi.emit("tool_execution_start", toolStart("subagent", "call-1", { agent: "executor", task: "Implement" }), tuiContext());
  await clock.tickAsync(2_000);
  assert.equal(store.writeCalls.length, 1);
  assert.equal(store.writeCalls[0].members.some((m) => m.role === "leader"), true);
});
```

Also cover `/team-panel` modes, RPC never calling custom overlay, TUI never setting the details widget, write heartbeat cadence, last-good aggregate retention after a malformed read, terminal removal after 30 seconds, and shard removal on shutdown.

- [ ] **Step 2: Run controller tests and confirm red**

Run: `node --experimental-strip-types --test test/team-status/controller.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `controller.ts`.

- [ ] **Step 3: Implement controller registration and idempotent teardown**

`registerTeamStatus()` registers handlers for:

```ts
pi.on("session_start", ...);
pi.on("session_shutdown", ...);
pi.on("tool_execution_start", ...);
pi.on("tool_execution_update", ...);
pi.on("tool_execution_end", ...);
pi.on("message_end", ...);
```

The 1-second tick performs, in order: refresh async adapter if writer, prune local terminal members, write heartbeat when due, read current-session shards, aggregate with the last-good fallback, project status/widget or refresh overlay. In `auto`, details appear only while the aggregate contains members; `show` keeps the current-session projection mounted; `hide` clears overlay, status, and widget. Wrap each boundary in a rate-limited diagnostic guard; one failure cannot stop the interval.

Register `/team-panel` with exact accepted values `show`, `hide`, `auto`. Unknown input reports `用法: /team-panel show|hide|auto` without changing mode.

- [ ] **Step 4: Wire the controller into the existing extension**

At the top of `extensions/index.ts` import `getAgentDir` and the controller:

```ts
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTeamStatus } from "./team-status/controller.ts";
```

At the start of the default factory:

```ts
const teamStatus = registerTeamStatus(pi, { agentDir: getAgentDir() });
```

At the successful end of `/team`, after `sendUserMessage()` resolves:

```ts
teamStatus.activateTeam(ctx, "Team 协作模式");
report(ctx, "协作模式激活：编排协议已作为 follow-up 加载", "success");
```

Do not activate the Leader on missing model, failed `setModel`, or missing `subagent` tool.

- [ ] **Step 5: Run the complete automated gate**

Run: `npm test && npm run typecheck && git diff --check`  
Expected: all commands exit 0; no timer/open-handle warning is printed by Node test runner.

- [ ] **Step 6: Commit**

```bash
git add extensions/team-status/controller.ts test/team-status/controller.test.mjs extensions/index.ts
git commit -m "feat(team): integrate visualization lifecycle"
```

---

### Task 9: Stock pi-web Fixture, Documentation, and End-to-End Gate

**Files:**
- Create: `scripts/write-team-status-fixture.mjs`
- Create: `docs/team-visualization-validation.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: public `TeamShardStore` and approved installation path.
- Produces: a deterministic local fixture command and a recorded E2E checklist; no production API.

- [ ] **Step 1: Write a deterministic fixture script**

`scripts/write-team-status-fixture.mjs` accepts required `--agent-dir` and `--session-id` plus optional `--duration-ms` (default `60000`), writes one live Leader + Executor shard using production store/reducer APIs, refreshes heartbeat until the duration expires, then removes the shard in `finally`. Reject missing required arguments or a non-positive duration with exit code 2.

Example invocation:

```bash
node --experimental-strip-types scripts/write-team-status-fixture.mjs \
  --agent-dir "$HOME/.pi/agent" \
  --session-id "01a040fe-5145-759f-a32f-5ad7b9a0c904"
```

- [ ] **Step 2: Test the fixture against a temp agent directory**

Run:

```bash
TMP_AGENT_DIR="$(mktemp -d)"
node --experimental-strip-types scripts/write-team-status-fixture.mjs --agent-dir "$TMP_AGENT_DIR" --session-id fixture-session --duration-ms 100
find "$TMP_AGENT_DIR/team-status/v1" -type f -print
rm -rf "$TMP_AGENT_DIR"
```

Expected: script exits 0; after cleanup, `find` prints no `.json`, `.tmp`, or `.bak` file.

- [ ] **Step 3: Document exact manual stock pi-web validation**

Create `docs/team-visualization-validation.md` with these gates:

1. Back up `~/.pi/agent/settings.json`.
2. Temporarily replace the installed Git package entry with the absolute local worktree path; restore the backup after testing.
3. Restart stock pi-web and call `POST /api/agent/<session-id>` with `{"type":"get_commands"}`; assert `team-panel` has `source: "extension"` and the local package path.
4. Start the fixture for the same session id; assert the Web footer contains `◆ Team`, click `team-status`, and verify Leader/Executor title and preview.
5. Start TUI from the same worktree, run `/team`, dispatch one async `executor`, and verify overlay + Web update without focus theft.
6. Complete/fail the child and measure that its card remains visible for 30 ± 2 seconds.
7. Resize TUI from 110 to 109 columns and verify details hide while status remains.
8. Run `/reload`, switch sessions, and stop both hosts; verify no stale widget and no shard newer than shutdown.
9. Restore the settings backup even if any gate fails.

Include a result table with columns `Gate`, `Command/Evidence`, `Observed`, `Pass` and record the actual observation during execution.

- [ ] **Step 4: Update README usage and limitations**

Add a “团队可视化” section documenting:

```text
/team-panel auto   # 有团队活动时显示（默认）
/team-panel show   # 始终投影当前会话团队状态
/team-panel hide   # 清除 overlay/status/widget
```

State explicitly that stock pi-web uses its Extension Widget near the editor, may collapse lists longer than three lines, and requires no pi-web source modification. Include the local preview persistence/security caveat and the parent-process-exit limitation.

- [ ] **Step 5: Run the final verification suite**

Run:

```bash
npm test
npm run typecheck
git diff --check
git status --short
```

Expected: tests/typecheck/diff-check exit 0; status contains only intended repository files and the pre-existing untracked `.pi/settings.json` plus `.pi/git/.gitignore`.

Then execute every manual gate in `docs/team-visualization-validation.md` and fill the result table with observed evidence. Any failed gate blocks completion.

- [ ] **Step 6: Commit**

```bash
git add README.md scripts/write-team-status-fixture.mjs docs/team-visualization-validation.md
git commit -m "docs(team): document visualization validation"
```

---

## Final Review Gate

After Task 9:

1. Dispatch a fresh `reviewer` with the approved spec, this plan, `git diff main...HEAD`, and all test/E2E evidence.
2. Require review of every branch: TUI/RPC, foreground/async, Team/other, writer/observer, active/terminal/stale, Unix/Windows atomic replace.
3. Fix every accepted Critical/Important finding through another executor → fresh reviewer iteration.
4. Run fresh verification again: `npm test`, `npm run typecheck`, `git diff --check`, manual stock pi-web checklist.
5. Only after the fresh reviewer verdict is `通过`, prepare the branch integration/PR decision.
