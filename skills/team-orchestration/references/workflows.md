# workflowScript 编排配方

多 agent 派发一律走 `workflowScript`（含单个子 agent）。这里给出团队的标准配方。

## 单个任务（同步等结果）

```js
return runs.run("main", {
  agent: "executor",
  task: `<任务包，按 references/task-packets.md 规范构造>`
})
```

## 执行+评审门（标准配方，强制）

每个 executor 任务包完成后必经 reviewer 评审，执行汇报与评审报告一起返回。单任务版：

```js
const done = await runs.run("t1", {
  agent: "executor",
  task: `<任务包>`
});
const review = await runs.run("t1-review", {
  agent: "reviewer",
  task: `<评审任务包，按 references/task-packets.md「评审任务包」构造：
        任务包原文 + 执行汇报 + 查看变更的方式>`
});
return { exec: done, review };
```

## 并行执行+评审门（多任务包）

独立域任务包并行执行，然后逐包配对评审（评审阶段也可并行）：

```js
const tasks = [
  { key: "t1", task: `<任务包 1（独立域）>` },
  { key: "t2", task: `<任务包 2（独立域）>` },
  { key: "t3", task: `<任务包 3（独立域）>` },
];
// 阶段 1：并行执行（仅独立域；相关任务包先串行或合并，见 SKILL.md「并行派发纪律」）
const done = await runs.all(tasks.map(t => () =>
  runs.run(t.key, { agent: "executor", task: t.task })));

// 阶段 2：逐包配对评审（reviewer 拿任务包原文 + 执行汇报）
const reviews = await runs.all(tasks.map((t, i) => () =>
  runs.run(t.key + "-review", {
    agent: "reviewer",
    task: `## 被评审的任务包\n${t.task}\n\n## 执行者汇报\n${done[i].output}`
  })));

// 返回配对摘要（领导者按「接收评审纪律」裁决）
return tasks.map((t, i) => ({
  key: t.key,
  execSummary: (done[i].output ?? "").slice(0, 400),
  reviewSummary: (reviews[i].output ?? "").slice(0, 600),
}));
```

要点：
- `key` 用稳定标识（任务编号/文件名），便于失败重派与修复闭环定位
- **修复闭环**：领导者裁决采纳 Critical/Important 后，派回原 executor 修复（key 不变），修复后重过一次 reviewer（如 key + "-review-2"），直到 verdict 通过或领导者显式接受剩余风险
- 返回给领导者的是**摘要**（slice 截断），完整输出留在 run 记录里，需要时再查——保护领导者上下文
- 返回后必做「并行派发纪律」的整合三步：查冲突 → 全量测试 → 抽查

## 研究 fan-out（researcher 并行）

```js
const questions = [
  { key: "q1", q: `<子问题 1（含背景与期望简报重点）>` },
  { key: "q2", q: `<子问题 2>` },
];
const results = await runs.all(questions.map(item => () =>
  runs.run(item.key, { agent: "deep-researcher", task: item.q })
));
return results.map((r, i) => ({ key: questions[i].key, brief: r.output }));
```

## challenge 循环

challenge 由领导者手动驱动（派发 → 读 findings → 裁决 → 修订设计 → 可选再审）：

```js
return runs.run("challenge", {
  agent: "challenger",
  task: `<设计文档全文 + 决策上下文摘要 + 请审查的维度清单>`
})
```

若需要「实现后审查」，把 diff 或变更文件清单构造进任务包再派一次。

## 通用纪律

- 脚本默认异步启动，用 `subagent_wait` 等待；小任务可 `async: false` 前台
- 失败的子 run 记下 key 与原因，修正任务包后单独重派，不重跑整批
- 每个任务的 `task` 字段就是任务包本体，遵循 references/task-packets.md
