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

function captureRecipe(sectionText) {
  const block = sectionText.match(/```js\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(block, "recipe must contain a JavaScript block");
  let call;
  new Function("subagent", block)((params) => {
    call = params;
  });
  assert.ok(call, "recipe must call subagent");
  return call;
}

async function executeWorkflowRecipe(call, initialEntries = []) {
  const memory = new Map(initialEntries);
  const runCalls = [];
  const state = {
    async get(key) {
      return memory.get(key);
    },
    async set(key, value) {
      memory.set(key, value);
    },
  };
  const runs = {
    async run(key, params) {
      runCalls.push({ key, params });
      return { runId: `${key}-run`, output: "ok", artifactPaths: [] };
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("state", "runs", call.workflowScript)(state, runs);
  return { runCalls, memory };
}

test("initial executor workflow ends before the reviewer workflow starts", () => {
  const executor = section(
    "## 阶段 1：初次 executor（完成即通知）",
    "## 阶段 2：fresh reviewer（独立 workflow）",
  );
  assert.match(executor, /implementation-done-pending-review/);
  assert.match(executor, /exec\.error \|\| exec\.timedOut \|\| exec\.stopped \|\| !exec\.runId/);
  assert.equal((executor.match(/runs\.run\(/g) ?? []).length, 1);
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
  assert.equal((reviewer.match(/runs\.run\(/g) ?? []).length, 1);
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
  assert.equal((fix.match(/runs\.run\(/g) ?? []).length, 1);
  assert.doesNotMatch(fix, /agent: "reviewer"/);
  assert.match(reReview, /lane\.phase !== "fix-done-pending-review"/);
  assert.match(reReview, /agent: "reviewer"/);
  assert.equal((reReview.match(/runs\.run\(/g) ?? []).length, 1);
  assert.match(reReview, /phase: "reviewed"/);
});

test("executor recipes expose the role immediately and use soft control with a distant hard backstop", async () => {
  const initial = captureRecipe(section(
    "## 阶段 1：初次 executor（完成即通知）",
    "## 阶段 2：fresh reviewer（独立 workflow）",
  ));
  const initialExecution = await executeWorkflowRecipe(initial);

  assert.equal(initial.timeoutMs, 7_200_000);
  assert.equal(initialExecution.runCalls.length, 1);
  assert.equal(initialExecution.runCalls[0].params.label, "executor");
  assert.equal(initialExecution.runCalls[0].params.timeoutMs, 7_200_000);
  assert.deepEqual(initialExecution.runCalls[0].params.control, { activeNoticeAfterMs: 480_000 });

  const fix = captureRecipe(section(
    "## 修复阶段：resume 原 executor（完成即通知）",
    "## 复审阶段：fresh reviewer（独立 workflow）",
  ));
  const fixExecution = await executeWorkflowRecipe(fix, [["lane.t1", {
    version: 1,
    laneKey: "t1",
    role: "executor",
    phase: "needs-fix",
    round: 1,
    latestRunId: "executor-run-1",
    latestWorkflowKey: "t1",
    acceptedFindings: ["fix this"],
    artifactRefs: [],
  }]]);

  assert.equal(fix.timeoutMs, 7_200_000);
  assert.equal(fixExecution.runCalls.length, 1);
  assert.equal(fixExecution.runCalls[0].params.label, "executor");
  assert.equal(fixExecution.runCalls[0].params.timeoutMs, 7_200_000);
  assert.deepEqual(fixExecution.runCalls[0].params.control, { activeNoticeAfterMs: 480_000 });
  assert.equal("agent" in fixExecution.runCalls[0].params, false);
});

test("workflow JavaScript examples remain syntactically valid", () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const blocks = [...workflows.matchAll(/```js\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(blocks.length > 0);
  blocks.forEach((code, index) => {
    assert.doesNotThrow(
      () => new AsyncFunction("subagent", "state", "runs", code),
      `JavaScript block ${index + 1} must parse`,
    );
  });
});

test("team protocol promises a leader wake at each implementation gate", () => {
  assert.match(skill, /executor 完成.*workflow terminal.*领导者收到完成提醒/s);
  assert.match(skill, /reviewer 完成.*workflow terminal.*领导者收到完成提醒/s);
  assert.match(skill, /fix.*re-review.*独立的顶层 async workflow/s);
  assert.match(readme, /executor、reviewer、fix、re-review.*分别结束顶层 async workflow/s);
});
