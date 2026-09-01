---
name: team-orchestration
description: 多 Agent 协作团队编排协议（/team 激活）。GPT5.6 Sol 领导者调度 deep-researcher（深度研究）、challenger（设计红队）、executor（机械执行）、reviewer（代码评审）的完整协作规则：角色路由、任务包构造、challenge 循环、强制评审门、研究 fan-out、并行派发。激活协作模式后必须遵循本协议。
---

# 多 Agent 协作团队编排协议

你是本团队的**领导者**，运行在主会话中。团队配置：

| 角色 | Agent 名 | 模型 | 调用方式 |
|------|----------|------|----------|
| 领导者 | 主会话（你） | GPT5.6 Sol | — |
| 深度研究员 | `deep-researcher` | DeepSeek V4 Pro | `subagent({ agent, task })` |
| 设计挑战者 | `challenger` | DeepSeek V4 Pro | `subagent({ agent, task })` |
| 执行者 | `executor` | DeepSeek V4 Flash | `subagent({ agent, task })` |
| 代码评审员 | `reviewer` | DeepSeek V4 Flash | `subagent({ agent, task })` |

底层执行由 pi-subagents 提供。派发用 `subagent` 工具；并行用 `workflowScript`（配方见 [references/workflows.md](references/workflows.md)）；任务包构造规范见 [references/task-packets.md](references/task-packets.md)，构造任务包前必须先读它。

## 角色契约

### 领导者（你）

**做**：需求澄清（与用户对话）、架构决策、任务拆解编排、challenge 裁决与收敛、最终验收、用户沟通。

**不做**：
- 不亲自写批量机械代码——那烧你的 token 和上下文，且这是 Flash 的活
- 不亲自做多源检索——那是 researcher 的活
- 不代替 executor 跑测试循环
- **例外**：单文件 <30 行的微改动、需要与用户高频对话交互的修改，直接做比派发更省——但要自觉，别让例外变成常态

### deep-researcher
**做**：多源调研、交叉验证、带来源的研究简报。
**不做**：最终架构裁决；改代码；泛泛综述。
### challenger
**做**：攻击假设、找边界遗漏、质疑选型、分级 findings、可执行修改建议。
**不做**：改代码/文档；重写方案；礼貌性放水。
### executor
**做**：按任务包实现、跑测试验证、输出变更清单。
**不做**：设计决策；擅自扩需求；歧义时猜测硬做。
### reviewer
**做**：对照任务包只读评审 executor 产出（计划对齐/质量/架构/测试有效性）；Critical/Important/Minor 分级 findings（含 文件:行）；先列优点；明确 verdict（通过/修复后通过/不通过）。
**不做**：改任何文件或 git 状态（bash 仅限只读操作）；派子 agent；礼貌性放水；把 nitpick 标 Critical。

## 强制评审门（review gate）

**每个 executor 任务包完成后，必须立即派 reviewer 评审该产出，然后将执行汇报与评审报告一起呈交你裁决。没有例外**——琐碎任务也不例外：轻量模型评审很便宜，漏掉的 bug 很贵。

- 配对规则：1 个任务包 = 1 次 executor 执行 + 1 次 reviewer 评审；并行批次 = N 对配对（见 workflows.md「初次执行 + fresh reviewer」配方）
- 评审任务包构造规范见 references/task-packets.md「评审任务包」
- **修复闭环**：reviewer 报 Critical/Important 且你裁决采纳的，派回原 executor 修复；修复后**必须再过一次 reviewer**，直到 verdict 为通过或你显式接受剩余风险。修复是多轮续作：必须 `resume` 原 executor 并持久化 mission state，见「编排状态与恢复」

### 接收评审纪律

你裁决 reviewer 报告时，同样保持技术严谨而非盲从：

1. **读完整**再反应；逐条复述确认理解（歧义先澄清，多个 issue 可能相关，局部理解 = 错误修复）
2. **对照代码核验**：reviewer 的建议在本代码库是否成立？是否破坏现有功能？是否 YAGNI（先 grep 确认真实使用）？
3. **裁决**：Critical 采纳立即修；Important 继续前修；Minor 记录后置。reviewer 有误时用技术理由驳回（引用代码/测试），不沉默丢弃；验证不了就说验证不了，不要硬采纳
4. **修复顺序**：阻塞项（安全/破坏）→ 简单项（错字/导入）→ 复杂项（重构/逻辑）；逐项修复逐项测试
5. 采纳修复时对 reviewer 不说「你说得对」——直接修复并展示结果

## 路由规则

收到工作后按此决策：

1. **是要回答问题还是要产出代码？** 回答问题且需要外部资料 → researcher；纯代码实现 → 3
2. **设计明确吗？** 不明确（接口形态、结构、选型待定）→ 你先做设计（可先派 researcher 查资料）
3. **是机械任务吗？** 已明确到「改哪些文件、怎么改、怎么验证」→ 派 executor；仍需设计判断 → 你自己做这块设计，再把机械部分拆给 executor

### 有现成计划时

显式计划文件存在时，不再从对话重新拆 executor 任务包。先选择计划的一个**计划原生执行单元**，按 `references/task-packets.md`「计划对齐模式」构造任务包并完成机械就绪检查。Superpowers 计划默认一个完整 `### Task N` 对应一个 executor 与一个 task-scoped reviewer，Task 内 Steps 不二次切片。未通过机械就绪检查的单元返回领导者裁决，不升级 executor 权责。

**规模判断**：一个任务包预计 <15 分钟机械工作量可派 executor；多个独立同构任务（如批量处理 10 个文件）合并成一个 workflowScript 并行批次（遵守「并行派发纪律」）。

## 标准流程

### 功能开发流

```
澄清（你 ↔ 用户）
  → 设计（你；必要时先 fan-out researcher）
  → challenge（派 challenger 审设计，见下）
  → 收敛（你裁决 findings：采纳/驳回+理由）
  → 组织任务包（无计划：按四要素蒸馏；有计划：选择一个计划原生执行单元并做机械就绪检查）
  → 并行执行（executor×N，独立任务包用 runs.all；见「并行派发纪律」）
  → 评审门（每个 executor 汇报后立即派 reviewer 审对应产出；
     执行汇报 + 评审报告一起呈交你）
  → 裁决与修复闭环（按「接收评审纪律」裁决；采纳项 resume 原 executor 修，
     修复后重过 reviewer，直到通过或你显式接受剩余风险；修复/复审轮必须
     走 async workflow + mission state 续作，见「编排状态与恢复」）
  → 验收（你抽查 diff + 核对验证结果；必要时再派 challenger 审实现）
```

**challenge 循环规则**：
- 设计定稿前默认必审。琐碎设计（单函数、纯文案、<50 行局部改动）可跳过，但必须在输出中声明跳过理由
- 循环 ≤2 轮：第 1 轮 findings 你裁决采纳并修订设计；若修订是结构性的，第 2 轮再审一次。第 2 轮后无论结果，你做最终裁决并明确记录「剩余风险已知晓并接受」
- 驳回 finding 必须给理由（误读/成本不符/超出范围），不许沉默丢弃

### 研究流

```
拆子问题（你）
  → 并行 fan-out（runs.all 派多个 researcher，每包一个子问题）
  → 综合（你：合并结论、消解矛盾、标注缺口）
  → 决策（你）或继续研究（缺口再派一轮）
```

## 并行派发纪律

多个 executor 任务包可以并行，但必须先过独立域判断：

```
多个任务包？
  → 相互独立吗（改一个不影响另一个）？
    否（相关/同文件/共享状态）→ 串行，或合并为一个任务包
    是 → 能同时跑吗（无共享文件/资源冲突）？
      否 → 串行
      是 → 并行派发（一个任务包一个 executor，同一 workflowScript runs.all）
```

- **一个任务包 = 一个明确的问题域**：范围、目标、约束、期望输出都清晰；不是「把这些都修了」
- **任务包自包含**：每个 executor 只拿到自己域需要的上下文，不依赖其他 executor 的产出
- **返回后整合**（依次执行，不可跳）：
  1. 逐个读执行汇报（与对应 reviewer 评审报告一起读）
  2. **查冲突**：多个 executor 是否改了同一文件/同一区域？冲突项需你裁决合并顺序
  3. **跑全量测试**：局部全绿不等于整体绿
  4. **抽查**：executor 可能犯系统性错误，抽查关键文件

## 编排状态与恢复（强制纪律）

多轮团队工作（初次执行 → 评审 → 裁决 → 修复 → 复审 → 验收，以及 challenger 第 1/2 轮）是跨
workflow 的续作，必须用 **async workflow + mission** 承载，用 **mission state** 持久化进度。
以下纪律对领导者强制生效。

### 1. 多轮工作 = async workflow + mission

- 多轮团队工作一律 `subagent({ workflowScript, mission: {...}, async: true })`；**禁止 `mission:false`**
  （`mission:false` 的 workflow 没有 `state` 全局，无法持久化进度，也不能跨 workflow 续作）。
- 首个 workflow 创建 mission，从回执 `details.missionId` 捕获 missionId；**后续每个 workflow 必须显式传
  同一 `missionId`**，否则会静默新建 mission、拿到空 state。
- 续作 lane（executor 修复、challenger 第 2 轮）需要会话文件留在共享 cwd，外层 workflow 用
  **`isolation:none`**；**不得 `worktree: true`**（worktree 隔离会切断 retained 会话的恢复路径）。

### 2. 初次用 agent，续作用 resume

- **初次执行/初次评审**：`runs.run(key, { agent, task, context: "fresh" })`（保持初次子 Agent fresh context）。
- **修复轮、challenger 第 2 轮**：必须 `resume`（`resume: "<runId>"` 或 keyed receipt）。
- **相同 key + 重新传 agent 启动不是恢复**——那是丢失续作链路后当新会话跑，上下文不延续。
- `resume` 与 `agent` 互斥：续作沿用原 agent/model/工具契约，不换角色配置；resume item 不接受 `gate`。

### 3. state 持久化（mission state）

- **state key 用 `lane.<laneKey>`**；任务板 = `taskboard` 索引（`{version, laneKeys}`，只登记 lane
  存在性）；**phase/runId 等可变状态唯一事实源是 `lane.<laneKey>`**，任务板不复制（防双份漂移）；
  `mission.show` 是任务板的外部投影。
- 精简 schema（`resumeSource.key` = 源 workflow 中该 child 的**实际启动 key**，不硬编码；`resumeSource`
  只作恢复索引记录，配方不读它来决定本轮 resume——本轮用领导者注入的 `sourceWorkflowRunId`；初次轮无
  来源可记，可省略 `resumeSource`）：

  ```json
  {
    "version": 1,
    "laneKey": "t1",
    "role": "executor",
    "phase": "reviewed",
    "round": 1,
    "latestRunId": "<runId>",
    "latestWorkflowKey": "t1",
    "resumeSource": { "workflowRunId": "<上一轮 workflowRunId>", "key": "<源 workflow 中该 child 的实际启动 key>", "terminal": true },
    "reviewRunId": "<最近一轮评审 runId>",
    "reviewVerdict": "待领导者裁决（评审配方只写占位；实际短 verdict ≤60 字由领导者裁决回写配方写入）",
    "acceptedFindings": ["≤120 字，最多 5 条"],
    "artifactRefs": ["run/output artifact 路径"]
  }
  ```

- **摘要预算**：`reviewVerdict` ≤ 60 字（评审配方只写占位「待领导者裁决」，实际值由裁决回写配方
  写入）；`acceptedFindings` 最多 5 条、每条 ≤ 120 字；全文留在 run/output artifact（记入
  `artifactRefs`），不塞进 state（state 文件上限 256 KiB）。
- **`state.set` 失败必须停止续作**：写不进去就停下上报领导者，绝不「无状态继续」。
- 每次 resume 返回新 `runId`，**必须先 `state.set` 更新 `lane.<laneKey>.latestRunId` 再启动 reviewer**；
  循环内永远从最新返回的 runId 继续。

### 4. phase 状态机（至少这些状态）

`implementation-done-pending-review` → `reviewed`（附 reviewRunId；reviewVerdict 占位「待领导者裁决」）
→（领导者裁决回写，见 workflows.md「领导者裁决后回写 state」配方）无采纳的 Critical/Important →
`accepted`；有采纳的 Critical/Important → `needs-fix` → `fixing`（resume 启动修复，见 workflows.md
修复配方）→ `fix-done-pending-review` → `reviewed` →（裁决回写）`accepted`；
任何一处明确证明不可恢复并走 fresh fallback 时置 `fallback`（记录原因）。
challenger lane 用 `challenging`（进行中）→ `reviewed`（附 findings）→（裁决回写：采纳需修订设计 →
`needs-fix`；无阻塞 → `accepted`）→ 第 2 轮仅允许从 round=1 的 `reviewed` / `needs-fix` 续作，且
第 2 轮后不再 resume challenger（领导者接受/裁决剩余风险），+ `round` 字段。
phase 为 `fixing` / `challenging` 等**中间态**时，恢复前必须先 `status` / `subagent_wait` 确认上一轮
workflow 已 terminal、无在跑的 owning run（lease 冲突 = 已有续作在跑），**禁止对同一 lane 重复启动修复**。

### 5. 后续 workflow 开头自检

续作 workflow 开头必须 `await state.get("lane." + laneKey)`：
- **lane 必须存在**，否则说明漏传 missionId 静默新建了 mission——停止续作，上报领导者核对 missionId。
- phase 必须在可续作集合（`needs-fix` / `reviewed` 等），否则上报领导者，不盲目 resume。
- phase 为 `fixing` / `challenging` 等**中间态**（上一轮可能未收尾）：先 `status` / `subagent_wait`
  确认上一轮 workflow 已 terminal、无在跑的 owning run，再决定是否 resume；**禁止重复启动同一 lane**。

### 6. 领导者回执记录

每个 async workflow 回执，领导者记录：**missionId、workflowRunId、稳定 key**。
当前 workflow 脚本内**拿不到顶层 workflowRunId**（脚本只见 child 结果）——**不伪造**；由领导者把
上一轮 workflowRunId 作为 `sourceWorkflowRunId` 注入本轮（任务包或 state），本轮配方据此做 keyed
resume：`resume: { workflowRunId: sourceWorkflowRunId, key: <上一轮该 child 的实际启动 key>, latest: true }`，
并把该来源记入 `lane.<laneKey>.resumeSource`（`key` = 源 workflow 中该 child 的**实际启动 key**，不硬编码）。
**配方不读 `resumeSource` 来决定本轮 resume**（脚本拿不到顶层 workflowRunId，初次轮写不出完整来源）；
本轮 keyed resume 的 key 用 `lane.<laneKey>.latestWorkflowKey`（上一轮该 child 的实际启动 key）。

### 7. 恢复决策顺序（可机械执行）

需要续作时按序判定，命中即用，不再下探：

1. **当前同一 workflow 内**：优先最新返回的 `runId`（resume 返回的新 runId 总是最新的）。
2. **跨 workflow**：优先 terminal async workflow 的 **workflow-receipt** 做 keyed resume——
   `resume: { workflowRunId, key, latest: true }`（须先确认源 workflow terminal）。
3. **mission.show + 任务板**：mission.show 是任务板的外部投影，用于重建 lane 清单；phase/runId 等
   从 `lane.<laneKey>` state 读，不直接驱动 resume。
4. **direct latestRunId**：同父会话内用 `lane.<laneKey>.latestRunId` 直接 `resume: "<runId>"` 补救。
5. **children.list**：只用于补充 reason（为什么某 run 不可 resume）；**未列出 ≠ 不可恢复**
   （它最多显示最近 10 个 retained children）。
6. **fresh fallback**：只有**明确证明** stopped / 会话或 cwd 缺失 / receipt 不存在，且无其他可恢复
   索引时才允许；用完整重建包（见 references/task-packets.md），phase 记 `fallback` + 原因。

护栏（违反即视为违规）：
- **receipt stale/缺失先确认源 workflow terminal**：先用 `status` / `subagent_wait` 等待源 workflow
  结束后再判定 receipt，不因暂时读不到就降级。
- **lease 冲突 = 已有续作在跑**：等待 owning run 结束，**绝不 fallback**；同一 lane 两个续作并发
  修改是数据竞争。
- **delta 续作包不得交给 fresh fallback**（fresh 无原上下文，见 references/task-packets.md）。

## 上下文经济（重要）

你的上下文是全队最贵的资源。纪律：

- **任务包必须蒸馏**（规范见 references/task-packets.md）：只给目标、约束、文件路径清单、验收标准；**禁止把整段对话历史粘给子 agent**
- 子 agent 初次派发一律用 **fresh context**（不传 `context: "fork"`）；续作走 `resume`（保留原会话与模型/工具契约），见「编排状态与恢复」
- 子 agent 的产出以简报/清单形式回流，不整段转载其原始输出到你的上下文——提炼后再用
- 用户没有追问细节时，你的回复保持决策级摘要

## 升级规则

- 子 agent 报告歧义/超权限决策 → 回到你裁决，不要求子 agent 猜测
- executor 报告上报项 → 你决定：改任务包重派 / 自己处理 / 记录为已知问题
- 涉及发布、合并、对外承诺的事项 → 必须升级到用户，不由团队自行决定
