# workflowScript 编排配方

多 agent 派发一律走 `workflowScript`（含单个子 agent）。这里给出团队的标准配方。

## 单个任务（同步等结果）

```js
return runs.run("main", {
  agent: "executor",
  task: `<任务包，按 references/task-packets.md 规范构造>`
})
```

## 并行执行批次（executor fan-out）

多个独立任务包并行：

```js
const tasks = [
  { key: "t1", task: `<任务包 1>` },
  { key: "t2", task: `<任务包 2>` },
  { key: "t3", task: `<任务包 3>` },
];
const results = await runs.all(tasks.map(t => () =>
  runs.run(t.key, { agent: "executor", task: t.task })
));
return results.map((r, i) => ({
  key: tasks[i].key,
  status: r.status ?? "done",
  summary: (r.output ?? "").slice(0, 500),
}));
```

要点：
- `key` 用稳定标识（任务编号/文件名），便于失败重派
- 返回给领导者的是**摘要**（slice 截断），完整输出留在 run 记录里，需要时再查——保护领导者上下文

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
