# workflowScript 编排配方

多 agent 派发一律走 `workflowScript`（含单个子 agent）。多轮团队工作必须用
**async workflow + mission**（见 SKILL.md「编排状态与恢复」）。这里给出可直接抄用的配方。

> **API 约定（pi-subagents@0.56.0）**：
> - `runs.all([{ key, agent, task }, ...])` 接受**对象数组**，返回有序数组（用索引/解构/`.map`，不用 `results.<key>`）；
> - `resume` 与 `agent` **互斥**，续作沿用原 agent/model/工具契约；resume item 不接受 `gate`；
> - keyed resume：`resume: { workflowRunId, key, latest: true }`（源 workflow 必须已 terminal，靠其 `workflow-receipt.json`）；
> - 后续 workflow 显式 `async: true` 且附**同一 `missionId`**；续作 lane 外层用 `isolation:none`（共享 cwd），不得 `worktree: true`；
> - 有 mission 的 workflow 内可用 `await state.get(key)` / `await state.set(key, value)`（`mission:false` 没有 `state` 全局）。

## 阶段 1：初次 executor（完成即通知）

初次执行用 `agent`（fresh context）。这个顶层 async workflow 只运行 executor、校验终态并写入
`implementation-done-pending-review`；不在同一 workflow 内启动 reviewer。

```js
subagent({
  workflowScript: `
    const laneKey = "t1";
    // 自检：初次执行时 lane 不应已存在（续作场景见下）
    if (await state.get("lane." + laneKey)) {
      throw new Error("lane " + laneKey + " 已存在：这不是初次执行，检查 missionId/流程");
    }

    const exec = await runs.run(laneKey, {
      agent: "executor",
      context: "fresh",            // 初次子 Agent 一律 fresh context
      task: \`<任务包，按 references/task-packets.md 规范构造>\`
    });
    if (exec.error || exec.timedOut || exec.stopped || !exec.runId) {
      throw new Error("executor 未成功完成：" + (exec.error ?? "缺少 retained run id"));
    }
    // 增量写 state：executor 完成
    await state.set("lane." + laneKey, {
      version: 1, laneKey, role: "executor",
      phase: "implementation-done-pending-review",
      round: 1, latestRunId: exec.runId, latestWorkflowKey: laneKey,
      reviewVerdict: "", acceptedFindings: [],
      artifactRefs: (exec.artifactPaths ?? []).slice(0, 5)
    });
    // 登记任务板：taskboard 是 {version, laneKeys} 索引，只登记 lane 存在性；
    // phase/runId 等可变状态唯一事实源是 lane.<key>（不复制进 taskboard，防双份漂移）
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
// 领导者记录回执：missionId = details.missionId；workflowRunId = 本 workflow 顶层 run id；
// stable keys = [t1]。下一轮 reviewer workflow 显式使用同一 missionId。
```

该顶层 async workflow 在 executor 与 state 写入完成后立即 terminal；普通 async completion wake 会通知领导者。领导者读取执行汇报并确认成功后，才启动阶段 2。

## 阶段 2：fresh reviewer（独立 workflow）

reviewer 使用与阶段 1 相同的 `missionId` 和 `laneKey`。领导者把原任务包、executor 汇报与 diff 定位方式注入评审任务包。

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

该 reviewer 是独立顶层 async workflow 的唯一 child。完成并写入 `reviewed` 后 workflow terminal，领导者收到第二次完成提醒并执行裁决回写。强制评审门没有取消，只从同一长 workflow 内部移动到 leader-visible 的下一阶段。

## 并行 executor：每个子 agent 独立通知

需要每个 executor 完成时分别提醒领导者，就不能把多个 executor 包在同一个 `runs.all` 顶层 workflow 中。独立域检查通过后，每个任务包各启动一个“阶段 1”顶层 async workflow；每条 lane 保存自己的 missionId、workflowRunId 与 child key。它们可以同时运行，但各自 terminal、各自产生 completion wake。对应 reviewer 只能在该 lane 的 executor wake 被领导者核验后启动。


## 领导者裁决后回写 state（可机械抄用）

初次/修复评审完成后 `lane.phase=reviewed`、`reviewVerdict="待领导者裁决"`（reviewer 不冒充 verdict，
全文留在 run 记录，由 `reviewRunId`/`artifactRefs` 索引）。领导者读完评审报告并裁决后，用本配方回写：
短 verdict 摘要 + 裁决后 `acceptedFindings`；**无阻塞项 → `phase=accepted`**，**有采纳的
Critical/Important → `phase=needs-fix`**（下方修复配方开头的 needs-fix 守卫以此为前提）。
调用方显式同一 `missionId`、`async: true`；state 写失败即停止上报领导者，绝不无状态继续。

```js
subagent({
  workflowScript: `
    const laneKey = "<laneKey>";
    // 读取 lane：必须存在（防漏传 missionId 拿到空 state），且 phase 处于待裁决状态
    const lane = await state.get("lane." + laneKey);
    if (!lane) throw new Error("lane " + laneKey + " 不存在：检查 missionId，停止上报领导者");
    if (lane.phase !== "reviewed") {
      throw new Error("lane phase=" + lane.phase + " 不是 reviewed，无法裁决回写，上报领导者");
    }
    // 领导者裁决输入（从评审报告提炼）：verdict ≤60 字；acceptedFindings 每条 ≤120 字、最多 5 条
    const verdict = "<短 verdict 摘要：通过 / 修复后通过（≤60 字）>";
    const acceptedFindings = [
      "<采纳且要求修复的 Critical/Important finding 摘要 1>",
      // ...最多 5 条；未采纳的用技术理由驳回，不进 acceptedFindings
      // 若领导者显式接受某项剩余风险：不放入此阻塞列表，另记 mission 决策/风险摘要，并在 verdict 中注明
    ];
    // 有采纳且要求修复的 Critical/Important = 阻塞，需修复轮；无阻塞项 → accepted 直接验收
    const needsFix = acceptedFindings.length > 0;
    await state.set("lane." + laneKey, {
      ...lane,
      phase: needsFix ? "needs-fix" : "accepted",
      reviewVerdict: verdict,
      acceptedFindings
    });
    return { laneKey, phase: needsFix ? "needs-fix" : "accepted" };
  `,
  missionId: "<同一 missionId>",
  async: true
})
// 回写后：phase=accepted → 验收；phase=needs-fix → 走下方「领导者裁决后：resume 原 executor」修复配方。
```

## 修复阶段：resume 原 executor（完成即通知）

裁决采纳 Critical/Important 后派回原 executor 修复。**修复必须 resume**（相同 key + 重新 agent
不是恢复）。这个顶层 async workflow 只运行 fix 并写入 `fix-done-pending-review`；不在同一 workflow 内启动 reviewer。

```js
subagent({
  workflowScript: `
    const laneKey = "t1";
    // 开头自检：lane 必须存在（防漏传 missionId 静默新建 mission，拿到空 state）
    const lane = await state.get("lane." + laneKey);
    if (!lane) throw new Error("lane " + laneKey + " 不存在：检查 missionId，停止续作上报领导者");
    if (lane.phase !== "needs-fix") {
      throw new Error("lane phase=" + lane.phase + " 不可续作修复，上报领导者裁决");
    }
    // 领导者注入的上一轮 workflowRunId（回执记录）；当前 workflow 内拿不到顶层 id，不伪造
    const sourceWorkflowRunId = "<领导者注入的上一轮 workflowRunId>";
    // 每轮修复用独立 fixKey（含轮次）：下一轮 receipt 按上一轮 workflowRunId + fixKey 定位，不丢修复 lineage
    const fixKey = laneKey + "-fix-" + (lane.round + 1);

    // phase → fixing：先写状态再启动；若本轮中断，恢复时凭中间态做 status/lease 检查，禁止重复启动
    await state.set("lane." + laneKey, { ...lane, phase: "fixing" });

    const fix = await runs.run(fixKey, {
      // 跨 workflow 优先 keyed receipt；key 必须是上一轮该 child 的实际启动 key（= lane.latestWorkflowKey）；
      // 同父会话拿不到 receipt 时可改用 resume: lane.latestRunId 补救
      resume: { workflowRunId: sourceWorkflowRunId, key: lane.latestWorkflowKey, latest: true },
      task: \`<resume 续作包：仅裁决后采纳 findings + 仍适用约束 + 验证标准
             （references/task-packets.md「续作任务包」）>\`
    });
    if (fix.error || fix.timedOut || fix.stopped || !fix.runId) {
      throw new Error("fix 未成功完成：" + (fix.error ?? "缺少 retained run id"));
    }

    // 每次 resume 后立即更新 latestRunId / latestWorkflowKey，并结束 fix workflow 等待领导者核验
    const fixed = await state.get("lane." + laneKey);
    await state.set("lane." + laneKey, {
      ...fixed,
      round: lane.round + 1,
      phase: "fix-done-pending-review",
      latestRunId: fix.runId,              // 永远用最新返回的 runId
      latestWorkflowKey: fixKey,           // 本轮 child 实际启动 key；下一轮 resume 的 key 用它
      resumeSource: { workflowRunId: sourceWorkflowRunId, key: lane.latestWorkflowKey, terminal: true }
    });

    return {
      laneKey,
      fixRunId: fix.runId,
      fixSummary: (fix.output ?? "").slice(0, 400)
    };
  `,
  missionId: "<同一 missionId>",
  async: true,
  isolation: "none"   // retained resume 需要共享 cwd；不得 worktree: true
})
// 领导者记录本轮 workflowRunId；下一阶段 reviewer workflow 显式使用同一 missionId。
```

该 fix workflow 在写入 `fix-done-pending-review` 后立即 terminal，领导者收到完成提醒并核验修复报告，再启动复审阶段。

## 复审阶段：fresh reviewer（独立 workflow）

复审使用与 fix 相同的 `missionId` 和 `laneKey`。领导者注入原任务包、fix 汇报、fix diff 定位方式与 open findings。

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

该 re-review workflow 在写入 `reviewed` 后立即 terminal，领导者收到完成提醒并再次执行裁决回写。

## challenger 第 1 轮（fresh）

challenge 由领导者手动驱动（派发 → 读 findings → 裁决 → 修订设计 → 可选再审）：

```js
subagent({
  workflowScript: `
    const laneKey = "challenge";
    // 进行中 phase = challenging；完成后置 reviewed
    await state.set("lane." + laneKey, {
      version: 1, laneKey, role: "challenger", phase: "challenging", round: 1,
      latestRunId: "", latestWorkflowKey: laneKey, reviewVerdict: "", acceptedFindings: [], artifactRefs: []
    });
    // 登记任务板（{version, laneKeys} 索引；可变状态唯一事实源是 lane.<key>）
    const board = await state.get("taskboard") ?? { version: 1, laneKeys: [] };
    if (!board.laneKeys.includes(laneKey)) {
      await state.set("taskboard", { ...board, laneKeys: [...board.laneKeys, laneKey] });
    }
    const c1 = await runs.run(laneKey, {
      agent: "challenger", context: "fresh",
      task: \`<challenge 任务包：设计文档全文 + 决策上下文摘要 + 请审查的维度清单>\`
    });
    if (!c1.runId) throw new Error("challenger 未返回 retained run id，停止续作上报领导者");
    const lane = await state.get("lane." + laneKey);
    await state.set("lane." + laneKey, {
      ...lane, phase: "reviewed", latestRunId: c1.runId,
      reviewVerdict: "待领导者裁决",   // findings 全文留在 run 记录；verdict 由领导者裁决回写配方设置
      reviewRunId: c1.runId,
      artifactRefs: [...(lane.artifactRefs ?? []), ...(c1.artifactPaths ?? [])].slice(0, 5)
    });
    return { runId: c1.runId, findings: (c1.output ?? "").slice(0, 600) };
  `,
  mission: { title: "挑战评审：<设计名>", objective: "对抗性审查设计并输出分级 findings" },
  async: true
})
// 领导者记录回执：missionId、workflowRunId、child key = challenge（第 2 轮 keyed resume 用它）
```

## challenger 第 2 轮（keyed receipt resume，强制）

第 1 轮 findings 领导者裁决并修订设计后，若修订是结构性的，**第 2 轮必须 resume 同一 challenger**
（相同 key + 重新 agent 不是恢复）。**第 2 轮是最后一轮**：之后不再 resume challenger，剩余风险由
领导者接受/裁决并明确记录（见 SKILL.md「challenge 循环规则」）。
**不依赖 `lane.resumeSource`**（第 1 轮脚本拿不到顶层
workflowRunId，写不出完整 resumeSource）：本轮直接使用领导者注入的 `sourceWorkflowRunId`。

```js
subagent({
  workflowScript: `
    const laneKey = "challenge";
    const lane = await state.get("lane." + laneKey);
    if (!lane) throw new Error("lane " + laneKey + " 不存在：检查 missionId，停止续作上报领导者");
    // 第 2 轮守卫：只允许从第 1 轮（round=1）的 reviewed / needs-fix 设计复审状态续作；
    // 其余 phase（challenging / fixing / accepted / fallback）或 round≠1 一律停止并上报领导者裁决
    if (lane.round !== 1 || (lane.phase !== "reviewed" && lane.phase !== "needs-fix")) {
      throw new Error("challenge lane round=" + lane.round + " phase=" + lane.phase +
        " 不允许第 2 轮续作（只允许 round=1 且 phase=reviewed/needs-fix），上报领导者裁决");
    }
    // 领导者注入第 1 轮 workflowRunId（回执记录）。前置：领导者必须先 status / subagent_wait
    // 确认源 workflow 已 terminal（receipt 依赖），并确认无在跑的 owning run（lease 冲突禁止重复启动）
    const sourceWorkflowRunId = "<领导者注入的第 1 轮 workflowRunId>";
    const c2Key = laneKey + "-r2";
    const c2 = await runs.run(c2Key, {
      // key 必须是第 1 轮该 challenger 的实际启动 key（= laneKey = "challenge"），不是本轮 c2Key
      resume: { workflowRunId: sourceWorkflowRunId, key: laneKey, latest: true },
      task: \`<challenger 第 2 轮包：修订后完整设计 + 第 1 轮裁决摘要 + 待审维度>\`
    });
    if (!c2.runId) throw new Error("第 2 轮未返回 retained run id，停止续作上报领导者");
    await state.set("lane." + laneKey, {
      ...lane, round: 2, phase: "reviewed", latestRunId: c2.runId,
      latestWorkflowKey: c2Key,   // 本轮 child 实际启动 key（回执记录用；第 2 轮后不再 resume challenger）
      resumeSource: { workflowRunId: sourceWorkflowRunId, key: laneKey, terminal: true },
      reviewVerdict: "待领导者裁决",
      reviewRunId: c2.runId,
      artifactRefs: [...(lane.artifactRefs ?? []), ...(c2.artifactPaths ?? [])].slice(0, 5)
    });
    return { runId: c2.runId, findings: (c2.output ?? "").slice(0, 600) };
  `,
  missionId: "<同一 missionId>",
  async: true,
  isolation: "none"   // resume 需共享 cwd；不得 worktree: true
})
// 领导者记录回执：第 2 轮 workflowRunId、child key = challenge-r2。
```

## 同 workflow 内多轮续作（循环 + resume 最新 runId）

同一 workflow 里要多次续作同一 child 时，循环变量必须接住每次 resume 返回的新 runId
（**当前同一 workflow 内优先最新返回的 runId**）：

```js
let writer = await runs.run("implement", {
  agent: "executor", context: "fresh", task: `<任务包>`
});
if (!writer.runId) throw new Error("writer 未返回 retained run id，停止续作");
await state.set("lane.implement", {
  version: 1, laneKey: "implement", role: "executor",
  phase: "implementation-done-pending-review", round: 1,
  latestRunId: writer.runId, latestWorkflowKey: "implement",
  reviewVerdict: "", acceptedFindings: [], artifactRefs: []
});
for (const pass of [1, 2]) {
  const followKey = "followup-" + pass;   // 每轮独立 child key，receipt 可定位
  writer = await runs.run(followKey, {
    resume: writer.runId,   // 永远 resume 最新返回的 runId
    task: `<续作任务包>`
  });
  if (!writer.runId) throw new Error("followup 未返回 retained run id，停止续作");
  await state.set("lane.implement", {
    ...(await state.get("lane.implement")),
    round: 1 + pass,
    latestRunId: writer.runId,
    latestWorkflowKey: followKey   // 本轮 child 实际启动 key，跨 workflow 续作时按它定位
  });
}
return writer;
```

## 恢复索引 / 降级流程（领导者侧）

1. 需要续作某 lane 时先重建索引：
   - `subagent({ action: "mission.show", missionId })` → 任务板的外部投影（哪些 lane 存在）；
   - 读 `lane.<laneKey>` state → `phase` / `latestRunId` / `latestWorkflowKey` / `resumeSource`
     （**可变状态唯一事实源是 `lane.<key>`**，phase/runId 不复制进 taskboard）。
2. 按 SKILL.md「恢复决策顺序」判定：同 workflow 最新 runId → 跨 workflow receipt keyed resume →
   direct latestRunId → children.list 补 reason →（**明确证明**不可恢复才）fresh fallback。
3. 任务板读写（最小模板）：

```js
// 读任务板（{version, laneKeys} 索引，只登记 lane 存在性；mission.show 是其外部投影）
const board = await state.get("taskboard") ?? { version: 1, laneKeys: [] };

// 登记一个 laneKey（state.set 按 key 整值替换，先判存在再合并；不把 phase/runId 复制进 taskboard）
if (!board.laneKeys.includes(laneKey)) {
  await state.set("taskboard", { ...board, laneKeys: [...board.laneKeys, laneKey] });
}

// 读所有 lane 的可变状态：按 laneKeys 逐个 state.get（taskboard 不保存 phase/runId，防双份漂移）
for (const k of board.laneKeys) {
  const lane = await state.get("lane." + k);   // phase / latestRunId / latestWorkflowKey 只从这里读
  if (!lane) continue;                          // lane 未建/已删，跳过
  // ...使用 lane.phase / lane.latestRunId / lane.latestWorkflowKey
}
```

4. 降级判定护栏（违反即违规，见 SKILL.md）：receipt stale 先 `status` 确认源 workflow terminal；
   **lease 冲突等待 owning run，绝不 fallback**；**children.list 未列出 ≠ 不可恢复**；
   **delta 续作包不得交给 fresh fallback**。

## 一次性小任务（无多轮续作需求）

```js
// 多轮工作一律 async workflow + mission；仅一次性、无续作需求的小任务可前台同步等结果
return runs.run("main", {
  agent: "executor", context: "fresh",
  task: `<任务包，按 references/task-packets.md 规范构造>`
})
```

## 研究 fan-out（researcher 并行）

```js
const questions = [
  { key: "q1", q: `<子问题 1（含背景与期望简报重点）>` },
  { key: "q2", q: `<子问题 2>` },
];
const results = await runs.all(questions.map(item => ({
  key: item.key, agent: "deep-researcher", context: "fresh", task: item.q
})));
return results.map((r, i) => ({ key: questions[i].key, brief: r.output }));
```

## 通用纪律

- 多轮工作的每个 executor/reviewer/fix/re-review 阶段必须使用独立顶层 `async: true` workflow + mission/missionId（见 SKILL.md「编排状态与恢复」）；仅一次性小任务可前台同步。async 启动后立即把控制权交回用户，依靠普通 completion wake；只有原生通知缺失或状态需要核对时才检查 status / `subagent_wait`。领导者记录每轮回执（missionId / workflowRunId / keys）
- 失败的子 run：记下 key 与原因，修正任务包后**单独 resume 重派**，不重跑整批
- 每个任务的 `task` 字段就是任务包本体，遵循 references/task-packets.md
- resume item 不传 `agent` / `context` / `gate`（`agent` 与 `resume` 互斥、`gate` 被拒）
