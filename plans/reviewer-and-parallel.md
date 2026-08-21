# 变更计划：新增 reviewer 角色 + 强制执行后审查 + 并行执行者派发强化

## Context

两个需求：

1. **新增 reviewer 角色**（轻量模型，默认 DeepSeek V4 Flash）：对 executor 产出的代码做 review。**每次 executor 执行完成后，reviewer 必须做 review，然后执行者的任务汇报和 reviewer 的 review 报告一起提交给领导者**。Review 方式参考 superpowers 的 `requesting-code-review`（含 code-reviewer.md 模板：审查维度、Critical/Important/Minor 分级、只读约束、明确 verdict）与 `receiving-code-review`（接收方纪律：核验而非盲从、按阻塞→简单→复杂顺序修复、YAGNI 检查、有理由的 pushback）。
2. **并行执行者派发**：当前 SKILL.md 已有 `runs.all` 并行配方（workflows.md「并行执行批次」），但缺少 superpowers `dispatching-parallel-agents` 中的关键纪律——独立域识别（决策树）、同构任务包构造规则、并行条件判断（共享状态/相关失败不并行）、返回后整合验证（冲突检查/全量测试/抽查）。需要把这套纪律写入编排协议，并把并行执行流程升级为「executor 们 + reviewer 门」模式。

另外：远端有 3 个新提交（f40db78/3e0e6b1/d79f792，用户手工修改了三个 agent 的 description 去掉了具体模型名），已 pull；本次变更需兼容这些修改（保持「或其他轻量模型」的措辞风格，不回退用户改动）。

## Approach

### 1. 新增 `agents/reviewer.md`

仿 superpowers code-reviewer.md 模板设计角色契约：

- **frontmatter**：`name: reviewer`；`description: 代码评审（DeepSeek V4 Flash或其他轻量模型）——对执行者完成的代码做只读评审……`（沿用用户的措辞风格）；`tools: read, grep, find, ls, bash`（bash 用于跑测试/git diff——只读用途，需 `completionGuard: false`）；`fallbackModels: deepseek/deepseek-v4-flash, opencode-go/deepseek-v4-flash, qwen-token-plan/deepseek-v4-flash`；`acceptanceRole: read-only`；`acceptance: none`（与 researcher/challenger 一致，避免验收误报）；`inheritProjectContext: true`
- **system prompt**（superpowers 模板中文化+适配任务包制）：
  - 职责（做）：对照任务包审查实现（计划对齐/代码质量/架构/测试有效性/边界）；按 Critical（必须修：bug/安全/破坏功能）/ Important（应修：缺功能/错误处理弱/测试缺口）/ Minor（可选）分级，每条含 文件:行、问题、影响、修法；先肯定做得好的部分；给出明确 verdict（通过 / 修复后通过 / 不通过）
  - 边界（不做）：**只读评审**——不改任何文件、不改 git 状态（HEAD/index/branch）；不派子 agent（评审自己做完）；不给礼貌性放水；diff 过大时分趟审并在报告中说明
  - 输出格式：优点 → Issues（三级）→ 建议 → verdict（理由 1-2 句）

### 2. 扩展 `extensions/index.ts`：ROLES 增加 reviewer

`{ label: "代码评审员 reviewer", agent: "reviewer", baseModelId: "deepseek-v4-flash", defaultProvider: "deepseek" }`——`ensureDefaultsMaterialized()` / `/team-models`（交互+参数形式）/ `/team-doctor` 自动覆盖 reviewer。

### 3. 更新 `skills/team-orchestration/SKILL.md` 编排协议

- **角色表**加 reviewer 行
- **角色契约**加 reviewer 做/不做（对齐 reviewer.md）
- **功能开发流**改为：

```
澄清 → 设计 → challenge → 收敛 → 拆任务包
  → 并行执行（executor×N，runs.all，独立域才并行）
  → 强制 review 门（每个 executor 汇报 → 立即派 reviewer 审对应产出；
     review 报告与执行汇报一起呈交领导者）
  → 领导者裁决（按 receiving-code-review 纪律：核验不盲从；
     Critical 立即修、Important 继续前修、Minor 记录；修复派回原 executor）
  → 验收
```

- **review 门规则**：每个 executor 任务包完成后必经 reviewer（不可跳过，包括琐碎任务——轻量模型评审便宜）；并行批次 = N executor + N reviewer 配对（reviewer 在 executor 完成后即刻派发，可与其他 executor 并行）
- **接收 review 纪律**（receiving-code-review 中文化，写入领导者协议）：读完整→复述确认→对照代码核验→按 阻塞/简单/复杂 顺序修复→逐项测试；reviewer 有误时用技术理由驳回（引用代码/测试），不沉默丢弃
- **并行派发纪律**（dispatching-parallel-agents 中文化）：独立域判断（修一个不影响另一个才并行；共享文件/相关失败→串行或合并）；每任务包一个明确域+清晰目标+约束+期望输出；返回后：读各汇报→查冲突（是否改了同一文件）→全量测试→抽查

### 4. 更新 `references/workflows.md`：新增「执行+评审门」配方

```js
const tasks = [
  { key: "t1", task: `任务包 1` },
  { key: "t2", task: `任务包 2` },
];
// 阶段1：并行执行
const done = await runs.all(tasks.map(t => () =>
  runs.run(t.key, { agent: "executor", task: t.task })));
// 阶段2：每包配对评审（reviewer 拿执行汇报+任务包+变更清单，继续 runs.all 并行）
const reviews = await runs.all(tasks.map((t, i) => () =>
  runs.run(t.key + "-review", {
    agent: "reviewer",
    task: `评审任务包：${t.task}\n\n执行者汇报：${done[i].output}`
  })));
// 返回配对摘要
return tasks.map((t, i) => ({ key: t.key, exec: done[i].output?.slice(0,400), review: reviews[i].output?.slice(0,600) }));
```

失败重派纪律补充：executor 失败的 key 单独重派；reviewer 报 Critical 的包派回原 executor 修复后**必须再过一次 reviewer**（修复→复审闭环）。

### 5. 更新 `references/task-packets.md`：新增「评审任务包」构造规范

reviewer 的任务包四要素变体：被评审的任务包原文（对照基准）、执行者汇报全文（变更清单+验证结果）、git 范围或文件清单（如何看 diff）、重点审查维度（可选）。

### 6. 更新 `README.md`

角色表加 reviewer；命令文档的 agent 列表加 reviewer；功能流程描述更新。

## Files to modify

- `agents/reviewer.md`（新建）
- `extensions/index.ts`（ROLES 数组 +1 行；文件头注释）
- `skills/team-orchestration/SKILL.md`（角色表/契约/功能开发流/review 门/并行纪律）
- `skills/team-orchestration/references/workflows.md`（执行+评审门配方；修复→复审闭环）
- `skills/team-orchestration/references/task-packets.md`（评审任务包规范）
- `README.md`（角色表/流程/命令文档）

## Reuse

- superpowers 模板：`D:\Github projects\ImageSimplify\.pi\git\github.com\obra\superpowers\skills\{requesting-code-review, receiving-code-review, dispatching-parallel-agents}`
- 现有 agent 定义模式（`agents/challenger.md` 的 frontmatter + 做/不做契约 + 输出格式三段式）
- `extensions/index.ts` 的 ROLES/ensureDefaultsMaterialized/参数解析框架（加一行角色即可全部生效）
- `workflows.md` 现有 runs.all 配方（执行批次结构直接复用，追加评审阶段）
- pi-subagents 原生能力：runs.all 并行、reviewer 的 acceptance none 模式（与 researcher/challenger 相同的验收误报规避）

## Steps

- [ ] Step 1：`git pull` 确认远端最新（已完成的探索阶段确认：d79f792）；本地基于最新提交
- [ ] Step 2：新建 `agents/reviewer.md`
- [ ] Step 3：`extensions/index.ts` ROLES 加 reviewer
- [ ] Step 4：更新 SKILL.md（角色表/契约/流程/review 门/接收纪律/并行纪律）
- [ ] Step 5：更新 workflows.md + task-packets.md
- [ ] Step 6：更新 README.md
- [ ] Step 7：验证（见下）：doctor 物化 reviewer override → 真实 spawn reviewer 评审一个小改动 → 提交推送 → git 副本同步 → doctor 复核
- [ ] Step 8：更新 PLAN.md 记录本变更

## Verification

1. jiti 加载测试（extensions/index.ts）
2. `pi -p '/team-doctor'`：reviewer 出现在团队表且默认档位 `deepseek/deepseek-v4-flash` 自动物化
3. `pi -p '/team-models reviewer opencode-go/deepseek-v4-flash'` 参数形式可用；非法 spec 报错
4. **真实 spawn 冒烟**：scratch 项目中派 executor 做小改动 → 派 reviewer 评审该改动 → 核对 reviewer 实际模型（meta.json）与输出遵循分级格式
5. commit + push + `pi update --extensions` 同步 git 副本，重复 2 确认

## 风险与备注

- reviewer 的 `bash` 工具是只读用途（跑测试/git diff），但工具白名单层面无法限制 bash 只读——靠 system prompt 约束（superpowers 模板同款做法）+ `completionGuard: false` 避免误判
- 并行 executor 的「同文件冲突」由领导者按任务包规范预防（相关文件清单不重叠），reviewer 阶段的 verdict 也会暴露冲突
- opencode-go 中转对子 agent 请求有间歇超时（Step 8 发现），reviewer 的 fallback 链可兜底；若用户把 reviewer 指到 opencode-go 且超时，行为与现有角色一致
