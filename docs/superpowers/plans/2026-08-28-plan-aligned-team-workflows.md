# Plan-Aligned Team Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep general team task packets intact while aligning planned work to native plan tasks and making executor, reviewer, fix, and re-review phases notify the leader independently.

**Architecture:** This is a protocol-only change. Add plan-aware rules to the team skill and task-packet reference, then replace combined executor/reviewer workflow examples with one-child top-level async workflows linked by existing mission lane state. Contract tests read the Markdown resources and lock the required headings, guards, phase transitions, and absence of combined role execution.

**Tech Stack:** Markdown protocol resources, JavaScript ESM, Node.js built-in test runner (`node:test`), existing npm scripts.

**Spec:** `docs/superpowers/specs/2026-08-28-plan-aligned-dispatch-and-subagent-notifications-design.md`

## Global Constraints

- Preserve free-form four-part task packets when no plan is explicitly in use.
- Treat one complete Superpowers `### Task N` section as one execution and review unit; do not split its Steps into separate executor packets.
- Keep plan files read-only; runtime facts and rulings belong in the brief, ledger, mission state, or task packet.
- Send only mechanically ready work to `executor`; unresolved design returns to the leader.
- Use a separate top-level async workflow for executor, reviewer, fix, and re-review so each phase can produce its own completion wake.
- Preserve the mandatory reviewer gate and the existing mission lane recovery fields.
- Do not change model policy, pi-subagents spawning/resume internals, agent implementations, or extension runtime behavior.
- Do not add a universal plan parser, polling, filesystem watchers, completion relays, runtime dependencies, or new abstractions.
- Do not modify pre-existing untracked `.pi/` or `reports/` content.

---

### Task 1: Align team task packets with native plan tasks

**Files:**
- Create: `test/team-status/plan-aligned-task-packets.test.mjs`
- Modify: `skills/team-orchestration/references/task-packets.md`
- Modify: `skills/team-orchestration/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the plan-aware rules in `docs/superpowers/specs/2026-08-28-plan-aligned-dispatch-and-subagent-notifications-design.md` and the existing four-part task-packet contract.
- Produces: explicit `无计划模式`, `计划对齐模式`, `Superpowers 计划`, and `机械就绪检查` protocol sections that Task 2's workflow prompts continue to reference through `references/task-packets.md`.

- [ ] **Step 1: Add the failing plan-alignment contract test**

Create `test/team-status/plan-aligned-task-packets.test.mjs` with this exact content:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const taskPackets = readFileSync(
  new URL("../../skills/team-orchestration/references/task-packets.md", import.meta.url),
  "utf8",
);
const skill = readFileSync(
  new URL("../../skills/team-orchestration/SKILL.md", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

test("task-packet protocol preserves general mode and adds explicit plan alignment", () => {
  assert.match(taskPackets, /## 无计划模式/);
  assert.match(taskPackets, /## 计划对齐模式/);
  assert.match(taskPackets, /计划文件/);
  assert.match(taskPackets, /原生执行单元/);
  assert.match(taskPackets, /不得.*静默.*切换.*无计划模式/);
});

test("Superpowers plans keep one complete Task as one executor and review unit", () => {
  assert.match(taskPackets, /一个完整的 `### Task N`/);
  assert.match(taskPackets, /task-brief PLAN_FILE N/);
  assert.match(taskPackets, /不得把 Task 内的 Step 再拆成不同 executor 任务包/);
  assert.match(taskPackets, /executor 不读取整个计划文件/);
});

test("mechanical readiness returns unresolved work to the leader", () => {
  assert.match(taskPackets, /### 机械就绪检查/);
  assert.match(taskPackets, /精确文件或代码锚点/);
  assert.match(taskPackets, /具体验证命令与预期结果/);
  assert.match(taskPackets, /返回领导者裁决/);
  assert.match(skill, /计划原生执行单元/);
  assert.match(skill, /机械就绪检查/);
});

test("README documents general and plan-aligned task-packet modes", () => {
  assert.match(readme, /无计划.*四要素任务包/s);
  assert.match(readme, /有计划.*原生执行单元/s);
  assert.match(readme, /Superpowers.*`### Task N`/s);
});
```

- [ ] **Step 2: Run the focused test and verify the expected RED state**

Run:

```bash
node --test test/team-status/plan-aligned-task-packets.test.mjs
```

Expected: four failing subtests. The failures must report missing protocol text such as `## 无计划模式`, `## 计划对齐模式`, or `计划原生执行单元`; a syntax/import failure is not the expected RED state.

- [ ] **Step 3: Add general and plan-aligned modes to the task-packet reference**

In `skills/team-orchestration/references/task-packets.md`, keep the existing four-part structure and insert these sections before the current `## 结构` heading:

```markdown
## 无计划模式

没有显式计划文件时，领导者继续按本规范蒸馏任务包。任务包的四要素——目标、约束、相关文件、验收标准——是 executor 的完整要求来源。不要为了假装精确而虚构计划引用。

## 计划对齐模式

用户或执行流程显式指定计划文件时，任务包必须绑定该计划的一个**原生执行单元**，不得由领导者再次任意切片、合并或扩张。任务包额外包含：

- **计划文件**：只读计划的精确路径；
- **原生执行单元**：计划中的任务编号、标题或精确范围；
- **要求来源**：该单元的 brief 文件或原文范围；
- **运行时补充**：BASE commit、已落地的前置接口、领导者裁决、report 路径。

计划原文仍是要求来源。运行时补充只能解决计划编写后才出现的事实，不能覆盖、拓宽或重述其中的精确值。计划格式无法可靠识别时，领导者必须明确给出标题或范围；不能识别原生单元就停止派发并返回领导者，**不得静默切换到无计划模式**。

### Superpowers 计划

对 `superpowers:writing-plans` 生成的计划：

- 一个完整的 `### Task N` 是一次 executor 执行与一次 task-scoped reviewer 的共同单元；
- Task 内的 Step 由同一 executor 按顺序执行，**不得把 Task 内的 Step 再拆成不同 executor 任务包**；
- 可用时先运行 `task-brief PLAN_FILE N`，把输出的 brief 路径作为唯一要求文件；
- 精确代码、常量、命令、测试与预期结果留在 brief 中，不在派发提示里改写第二份；
- executor 读取 brief，不读取整个计划文件；
- 派发提示只补充该 Task 在项目中的位置、前置 Task 已产出的真实接口、领导者裁决与 report contract。

### 机械就绪检查

计划对齐任务派给 executor 前，领导者逐项确认：

- [ ] 有精确文件或代码锚点；
- [ ] 有明确操作或完整实现内容；
- [ ] 有具体验证命令与预期结果；
- [ ] 前置接口和依赖已解析；
- [ ] 不含待决定的架构、产品或 API 选择。

全部满足才派 executor。任一项不满足就返回领导者裁决或补齐设计；不得通过加入开放式研究、全仓调查、额外设计或宽泛测试来扩大 executor 权责。计划文件保持只读，裁决写入该计划已有的 ledger、mission decision 或任务包运行时补充。
```

Then change the opening sentence from:

```markdown
派发任何子 agent 前，把任务构造成一个**自包含的任务包**。
```

to:

```markdown
派发任何子 agent 前，先判断是无计划模式还是计划对齐模式，再构造一个**自包含的任务包**。
```

- [ ] **Step 4: Add the plan-aware routing rule to the team skill**

In `skills/team-orchestration/SKILL.md`, immediately after the three numbered routing rules, insert:

```markdown
### 有现成计划时

显式计划文件存在时，不再从对话重新拆 executor 任务包。先选择计划的一个**计划原生执行单元**，按 `references/task-packets.md`「计划对齐模式」构造任务包并完成机械就绪检查。Superpowers 计划默认一个完整 `### Task N` 对应一个 executor 与一个 task-scoped reviewer，Task 内 Steps 不二次切片。未通过机械就绪检查的单元返回领导者裁决，不升级 executor 权责。
```

In the feature-development flow, replace:

```text
  → 拆任务包（你，按 task-packets 规范；独立域拆包以便并行）
```

with:

```text
  → 组织任务包（无计划：按四要素蒸馏；有计划：选择一个计划原生执行单元并做机械就绪检查）
```

Do not change the model table, role definitions, or reviewer gate in this task.

- [ ] **Step 5: Document the two modes in README**

Immediately before README's existing paragraph beginning `编排协议细节见`, add:

```markdown
- **任务包双模式**：无计划时继续使用目标/约束/相关文件/验收标准四要素任务包；有计划时任务包必须绑定计划原生执行单元，不能再次任意切片或扩张。
- **Superpowers 对齐**：`superpowers:writing-plans` 计划中的一个完整 `### Task N` 对应一次 executor 执行与一次 task-scoped reviewer；Task 内 Steps 由同一 executor 顺序完成，精确要求通过 `task-brief` 交付。
- **机械就绪门**：缺少精确文件、操作、验证或仍需设计判断的计划单元返回领导者，不通过扩大 executor 职责来强行执行。
```

Update the `task-packets.md` tree comment to:

```text
│           ├── task-packets.md  # 通用/计划对齐任务包，以及初次/续作/重建三形态
```

- [ ] **Step 6: Run the focused and complete validation for Task 1**

Run:

```bash
node --test test/team-status/plan-aligned-task-packets.test.mjs
npm test
npm run typecheck
git diff --check
```

Expected:

- focused file: 4 passing tests, 0 failures;
- complete test command: all tests pass;
- TypeScript exits 0;
- `git diff --check` prints no whitespace errors.

- [ ] **Step 7: Commit Task 1**

```bash
git add \
  test/team-status/plan-aligned-task-packets.test.mjs \
  skills/team-orchestration/references/task-packets.md \
  skills/team-orchestration/SKILL.md \
  README.md
git commit -m "docs(team): align task packets with plans"
```

---

### Task 2: Split implementation and review into independently notifying workflows

**Files:**
- Create: `test/team-status/workflow-notifications.test.mjs`
- Modify: `skills/team-orchestration/references/workflows.md`
- Modify: `skills/team-orchestration/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the existing lane fields `phase`, `round`, `latestRunId`, `latestWorkflowKey`, `reviewRunId`, `reviewVerdict`, `acceptedFindings`, and `artifactRefs`; the Task 1 task-packet modes remain unchanged.
- Produces: four top-level async phase recipes with exact state handoffs: executor → `implementation-done-pending-review`, reviewer → `reviewed`, fix → `fix-done-pending-review`, re-review → `reviewed`.

- [ ] **Step 1: Add the failing workflow-boundary contract test**

Create `test/team-status/workflow-notifications.test.mjs` with this exact content:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflows = readFileSync(
  new URL("../../skills/team-orchestration/references/workflows.md", import.meta.url),
  "utf8",
);
const skill = readFileSync(
  new URL("../../skills/team-orchestration/SKILL.md", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

function section(start, end) {
  const from = workflows.indexOf(start);
  const to = workflows.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section: ${start}`);
  assert.notEqual(to, -1, `missing section boundary: ${end}`);
  return workflows.slice(from, to);
}

test("initial executor workflow ends before the reviewer workflow starts", () => {
  const executor = section(
    "## 阶段 1：初次 executor（完成即通知）",
    "## 阶段 2：fresh reviewer（独立 workflow）",
  );
  assert.match(executor, /implementation-done-pending-review/);
  assert.match(executor, /exec\.error \|\| exec\.timedOut \|\| exec\.stopped \|\| !exec\.runId/);
  assert.doesNotMatch(executor, /agent: "reviewer"/);
});

test("initial reviewer requires executor completion and owns a separate workflow", () => {
  const reviewer = section(
    "## 阶段 2：fresh reviewer（独立 workflow）",
    "## 并行 executor：每个子 agent 独立通知",
  );
  assert.match(reviewer, /lane\.phase !== "implementation-done-pending-review"/);
  assert.match(reviewer, /phase: "reviewing"/);
  assert.match(reviewer, /agent: "reviewer"/);
  assert.match(reviewer, /phase: "reviewed"/);
});

test("fix and re-review are separate guarded workflows", () => {
  const fix = section(
    "## 修复阶段：resume 原 executor（完成即通知）",
    "## 复审阶段：fresh reviewer（独立 workflow）",
  );
  const reReview = section(
    "## 复审阶段：fresh reviewer（独立 workflow）",
    "## challenger 第 1 轮（fresh）",
  );
  assert.match(fix, /phase: "fix-done-pending-review"/);
  assert.doesNotMatch(fix, /agent: "reviewer"/);
  assert.match(reReview, /lane\.phase !== "fix-done-pending-review"/);
  assert.match(reReview, /agent: "reviewer"/);
  assert.match(reReview, /phase: "reviewed"/);
});

test("team protocol promises a leader wake at each implementation gate", () => {
  assert.match(skill, /executor 完成.*workflow terminal.*领导者收到完成提醒/s);
  assert.match(skill, /reviewer 完成.*workflow terminal.*领导者收到完成提醒/s);
  assert.match(skill, /fix.*re-review.*独立的顶层 async workflow/s);
  assert.match(readme, /executor、reviewer、fix、re-review.*分别结束顶层 async workflow/s);
});
```

- [ ] **Step 2: Run the focused test and verify the expected RED state**

Run:

```bash
node --test test/team-status/workflow-notifications.test.mjs
```

Expected: four failing subtests caused by missing new headings and wake contracts. A JavaScript syntax failure is not the expected RED state.

- [ ] **Step 3: Replace the combined initial executor/reviewer recipe**

In `skills/team-orchestration/references/workflows.md`, delete the existing sections `初次执行 + fresh reviewer（标准配方，强制评审门）` and `并行初次执行 + 配对评审（对象数组 API）`. Replace them with four sections in this order:

1. `## 阶段 1：初次 executor（完成即通知）`
2. `## 阶段 2：fresh reviewer（独立 workflow）`
3. `## 并行 executor：每个子 agent 独立通知`
4. `## 领导者裁决后回写 state（可机械抄用）` (retain its current body)

The executor recipe must use this result guard before writing successful state:

```js
if (exec.error || exec.timedOut || exec.stopped || !exec.runId) {
  throw new Error("executor 未成功完成：" + (exec.error ?? "缺少 retained run id"));
}
```

It then writes the existing lane fields with:

```js
phase: "implementation-done-pending-review"
```

and returns only:

```js
return {
  laneKey,
  execRunId: exec.runId,
  execSummary: (exec.output ?? "").slice(0, 400)
};
```

The executor workflow must contain no reviewer launch. End its section with this exact behavioral note:

```markdown
该顶层 async workflow 在 executor 与 state 写入完成后立即 terminal；普通 async completion wake 会通知领导者。领导者读取执行汇报并确认成功后，才启动阶段 2。
```

The separate reviewer workflow must begin with:

```js
const lane = await state.get("lane." + laneKey);
if (!lane) throw new Error("lane " + laneKey + " 不存在：检查 missionId，停止评审");
if (lane.phase !== "implementation-done-pending-review") {
  throw new Error("lane phase=" + lane.phase + " 不是 implementation-done-pending-review，停止评审");
}
await state.set("lane." + laneKey, { ...lane, phase: "reviewing" });
```

It launches one fresh reviewer using the original task packet, executor report, and diff locator. Before writing `reviewed`, guard the result with:

```js
if (review.error || review.timedOut || review.stopped || !review.runId) {
  throw new Error("reviewer 未成功完成：" + (review.error ?? "缺少 retained run id"));
}
```

It writes:

```js
await state.set("lane." + laneKey, {
  ...(await state.get("lane." + laneKey)),
  phase: "reviewed",
  reviewVerdict: "待领导者裁决",
  reviewRunId: review.runId,
  artifactRefs: [...(lane.artifactRefs ?? []), ...(review.artifactPaths ?? [])].slice(0, 5)
});
```

and returns only the reviewer run id and bounded summary. End with this exact note:

```markdown
该 reviewer 是独立顶层 async workflow 的唯一 child。完成并写入 `reviewed` 后 workflow terminal，领导者收到第二次完成提醒并执行裁决回写。强制评审门没有取消，只从同一长 workflow 内部移动到 leader-visible 的下一阶段。
```

For parallel executor work, document this exact rule instead of `runs.all`:

```markdown
## 并行 executor：每个子 agent 独立通知

需要每个 executor 完成时分别提醒领导者，就不能把多个 executor 包在同一个 `runs.all` 顶层 workflow 中。独立域检查通过后，每个任务包各启动一个“阶段 1”顶层 async workflow；每条 lane 保存自己的 missionId、workflowRunId 与 child key。它们可以同时运行，但各自 terminal、各自产生 completion wake。对应 reviewer 只能在该 lane 的 executor wake 被领导者核验后启动。
```

Do not change researcher fan-out or challenger recipes.

- [ ] **Step 4: Split the combined fix/re-review recipe**

Replace the current heading and combined recipe:

```markdown
## 领导者裁决后：resume 原 executor → 立即写 latestRunId/latestWorkflowKey → fresh reviewer → 留待裁决回写
```

with two sections:

```markdown
## 修复阶段：resume 原 executor（完成即通知）
## 复审阶段：fresh reviewer（独立 workflow）
```

Keep the existing `needs-fix` guard, keyed-receipt resume, `fixing` transition, and latest run/key update in the fix workflow. Remove the reviewer launch from it. After validating the fix result with:

```js
if (fix.error || fix.timedOut || fix.stopped || !fix.runId) {
  throw new Error("fix 未成功完成：" + (fix.error ?? "缺少 retained run id"));
}
```

write:

```js
phase: "fix-done-pending-review"
```

and return the fix run id plus bounded summary. State that this top-level workflow terminals and wakes the leader before re-review.

The new re-review workflow must require:

```js
const lane = await state.get("lane." + laneKey);
if (!lane) throw new Error("lane " + laneKey + " 不存在：检查 missionId，停止复审");
if (lane.phase !== "fix-done-pending-review") {
  throw new Error("lane phase=" + lane.phase + " 不是 fix-done-pending-review，停止复审");
}
await state.set("lane." + laneKey, { ...lane, phase: "reviewing" });
```

It launches one fresh reviewer with the original task packet, fix report, fix diff locator, and open findings. Apply the same reviewer terminal-result guard as Step 3, then write `reviewed`, `reviewRunId`, bounded artifacts, and the `待领导者裁决` placeholder. State that this workflow terminals and produces the next leader wake.

Retain the direct keyed-resume example below the fix section, but move it before the re-review section so it remains part of fix guidance.

Use these complete recipe bodies; only the task-packet template text and mission identifiers are caller-supplied values.

Initial executor:

```js
subagent({
  workflowScript: `
    const laneKey = "t1";
    if (await state.get("lane." + laneKey)) {
      throw new Error("lane " + laneKey + " 已存在：这不是初次执行，检查 missionId/流程");
    }

    const exec = await runs.run(laneKey, {
      agent: "executor",
      context: "fresh",
      task: \`<任务包，按 references/task-packets.md 的当前模式构造>\`
    });
    if (exec.error || exec.timedOut || exec.stopped || !exec.runId) {
      throw new Error("executor 未成功完成：" + (exec.error ?? "缺少 retained run id"));
    }

    await state.set("lane." + laneKey, {
      version: 1,
      laneKey,
      role: "executor",
      phase: "implementation-done-pending-review",
      round: 1,
      latestRunId: exec.runId,
      latestWorkflowKey: laneKey,
      reviewVerdict: "",
      acceptedFindings: [],
      artifactRefs: (exec.artifactPaths ?? []).slice(0, 5)
    });
    const board = await state.get("taskboard") ?? { version: 1, laneKeys: [] };
    if (!board.laneKeys.includes(laneKey)) {
      await state.set("taskboard", { ...board, laneKeys: [...board.laneKeys, laneKey] });
    }

    return {
      laneKey,
      execRunId: exec.runId,
      execSummary: (exec.output ?? "").slice(0, 400)
    };
  `,
  mission: { title: "团队任务：<任务名>", objective: "<一句话目标>" },
  async: true
})
```

Initial reviewer:

```js
subagent({
  workflowScript: `
    const laneKey = "t1";
    const lane = await state.get("lane." + laneKey);
    if (!lane) throw new Error("lane " + laneKey + " 不存在：检查 missionId，停止评审");
    if (lane.phase !== "implementation-done-pending-review") {
      throw new Error("lane phase=" + lane.phase + " 不是 implementation-done-pending-review，停止评审");
    }
    await state.set("lane." + laneKey, { ...lane, phase: "reviewing" });

    const review = await runs.run(laneKey + "-review", {
      agent: "reviewer",
      context: "fresh",
      task: \`<评审任务包：原任务包 + executor 汇报 + diff 定位方式>\`
    });
    if (review.error || review.timedOut || review.stopped || !review.runId) {
      throw new Error("reviewer 未成功完成：" + (review.error ?? "缺少 retained run id"));
    }

    const current = await state.get("lane." + laneKey);
    await state.set("lane." + laneKey, {
      ...current,
      phase: "reviewed",
      reviewVerdict: "待领导者裁决",
      reviewRunId: review.runId,
      artifactRefs: [...(lane.artifactRefs ?? []), ...(review.artifactPaths ?? [])].slice(0, 5)
    });
    return {
      laneKey,
      reviewRunId: review.runId,
      reviewSummary: (review.output ?? "").slice(0, 600)
    };
  `,
  missionId: "<同一 missionId>",
  async: true
})
```

Fix:

```js
subagent({
  workflowScript: `
    const laneKey = "t1";
    const lane = await state.get("lane." + laneKey);
    if (!lane) throw new Error("lane " + laneKey + " 不存在：检查 missionId，停止续作");
    if (lane.phase !== "needs-fix") {
      throw new Error("lane phase=" + lane.phase + " 不可续作修复，上报领导者裁决");
    }
    const sourceWorkflowRunId = "<领导者注入的上一轮 workflowRunId>";
    const fixKey = laneKey + "-fix-" + (lane.round + 1);
    await state.set("lane." + laneKey, { ...lane, phase: "fixing" });

    const fix = await runs.run(fixKey, {
      resume: { workflowRunId: sourceWorkflowRunId, key: lane.latestWorkflowKey, latest: true },
      task: \`<resume 续作包：采纳 findings + 仍适用约束 + 验证标准>\`
    });
    if (fix.error || fix.timedOut || fix.stopped || !fix.runId) {
      throw new Error("fix 未成功完成：" + (fix.error ?? "缺少 retained run id"));
    }

    const current = await state.get("lane." + laneKey);
    await state.set("lane." + laneKey, {
      ...current,
      round: lane.round + 1,
      phase: "fix-done-pending-review",
      latestRunId: fix.runId,
      latestWorkflowKey: fixKey,
      resumeSource: {
        workflowRunId: sourceWorkflowRunId,
        key: lane.latestWorkflowKey,
        terminal: true
      }
    });
    return {
      laneKey,
      fixRunId: fix.runId,
      fixSummary: (fix.output ?? "").slice(0, 400)
    };
  `,
  missionId: "<同一 missionId>",
  async: true,
  isolation: "none"
})
```

Re-review:

```js
subagent({
  workflowScript: `
    const laneKey = "t1";
    const lane = await state.get("lane." + laneKey);
    if (!lane) throw new Error("lane " + laneKey + " 不存在：检查 missionId，停止复审");
    if (lane.phase !== "fix-done-pending-review") {
      throw new Error("lane phase=" + lane.phase + " 不是 fix-done-pending-review，停止复审");
    }
    await state.set("lane." + laneKey, { ...lane, phase: "reviewing" });

    const review = await runs.run(laneKey + "-review-" + lane.round, {
      agent: "reviewer",
      context: "fresh",
      task: \`<修复后评审包：原任务包 + fix 汇报 + fix diff + open findings>\`
    });
    if (review.error || review.timedOut || review.stopped || !review.runId) {
      throw new Error("reviewer 未成功完成：" + (review.error ?? "缺少 retained run id"));
    }

    const current = await state.get("lane." + laneKey);
    await state.set("lane." + laneKey, {
      ...current,
      phase: "reviewed",
      reviewVerdict: "待领导者裁决",
      reviewRunId: review.runId,
      artifactRefs: [...(lane.artifactRefs ?? []), ...(review.artifactPaths ?? [])].slice(0, 5)
    });
    return {
      laneKey,
      reviewRunId: review.runId,
      reviewSummary: (review.output ?? "").slice(0, 600)
    };
  `,
  missionId: "<同一 missionId>",
  async: true
})
```

- [ ] **Step 5: Update the team skill state machine and orchestration rules**

In `skills/team-orchestration/SKILL.md`:

1. Replace the review-gate sentence that says executor and reviewer reports are presented together with:

```markdown
每个 executor 任务包完成后，executor 所在顶层 async workflow 必须先 terminal，让领导者收到完成提醒并核验结果；随后立即启动独立的 fresh reviewer workflow。reviewer 完成后其 workflow 再 terminal，领导者收到第二次提醒并裁决。没有例外。
```

2. In the feature-development flow, replace the combined execution/review wording with:

```text
  → executor 阶段（每个 executor 独立顶层 async workflow；完成后 terminal 并提醒领导者）
  → 领导者核验 executor 结果与 lane state
  → reviewer 阶段（每条 lane 独立 fresh reviewer workflow；完成后 terminal 并再次提醒领导者）
```

3. Replace parallel executor guidance `同一 workflowScript runs.all` with one top-level async workflow per executor lane. Leave researcher `runs.all` unchanged.

4. Update the mission discipline opening to state that executor/reviewer/fix/re-review are separate workflows sharing the lane's missionId.

5. Replace the implementation lane state-machine paragraph with:

```markdown
`executing` → `implementation-done-pending-review` → `reviewing` → `reviewed`（附 reviewRunId；reviewVerdict 占位「待领导者裁决」）→（领导者裁决回写）无采纳的 Critical/Important → `accepted`；有采纳项 → `needs-fix` → `fixing` → `fix-done-pending-review` → `reviewing` → `reviewed` →（裁决回写）`accepted`。
```

6. Add this explicit wake rule after the state machine:

```markdown
**完成提醒边界**：executor 完成、reviewer 完成、fix 完成、re-review 完成分别结束各自的顶层 async workflow。不得为了自动串接下一角色而让当前 workflow 保持运行；下一阶段由收到 completion wake 的领导者核验后启动。
```

- [ ] **Step 6: Update README with the new completion boundary**

Before `编排协议细节见`, add:

```markdown
- **逐 subagent 完成提醒**：executor、reviewer、fix、re-review 分别结束顶层 async workflow；每个角色完成后领导者都会收到 completion wake，核验当前结果与 lane phase 后再启动下一阶段。
- **评审门仍强制**：拆分 workflow 只改变提醒边界，不取消 executor 后的 fresh reviewer，也不允许失败 executor 进入评审。
```

Update the workflow tree comment to:

```text
│           └── workflows.md     # 分阶段 workflowScript 配方（逐角色通知、resume 续作与恢复索引）
```

Do not mention pi-subagents forks, package bundling, model routing, or launcher fixes.

- [ ] **Step 7: Run the focused and complete validation for Task 2**

Run:

```bash
node --test test/team-status/workflow-notifications.test.mjs
npm test
npm run typecheck
git diff --check
```

Expected:

- focused file: 4 passing tests, 0 failures;
- complete test command: all tests pass;
- TypeScript exits 0;
- `git diff --check` prints no whitespace errors.

Then manually inspect these four Markdown sections and confirm each contains exactly one `runs.run` child launch:

```bash
rg -n "^## (阶段 1|阶段 2|修复阶段|复审阶段)|runs\.run\(" skills/team-orchestration/references/workflows.md
```

Expected: each named phase has one role launch; executor/fix sections contain no reviewer launch.

- [ ] **Step 8: Commit Task 2**

```bash
git add \
  test/team-status/workflow-notifications.test.mjs \
  skills/team-orchestration/references/workflows.md \
  skills/team-orchestration/SKILL.md \
  README.md
git commit -m "docs(team): notify after each subagent phase"
```

---

## Final Verification

After both task commits, run:

```bash
npm test
npm run typecheck
git diff --check
git status --short
git log -3 --oneline
```

Expected:

- all Node tests pass;
- TypeScript exits 0;
- no whitespace errors;
- only the pre-existing untracked `.pi/` and `reports/` entries remain;
- history contains the spec commit plus the two task commits.

Re-read the spec acceptance criteria and map them to evidence:

| Spec criterion | Evidence |
|---|---|
| General packets still work | `无计划模式` contract test and unchanged four-part structure |
| Planned packets preserve native units | `计划对齐模式` and Superpowers contract tests |
| Non-mechanical work returns to leader | mechanical-readiness contract test |
| Executor notifies before reviewer | executor section has no reviewer and ends at pending-review |
| Reviewer is independently guarded | separate reviewer section checks pending-review phase |
| Fix and re-review are separate | fix section has no reviewer; re-review checks fix-pending phase |
| Failed executor cannot advance | executor terminal-result guard precedes state advancement |
| Reviewer gate remains mandatory | skill and README contract text plus reviewer recipes |
