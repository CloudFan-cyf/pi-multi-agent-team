# 多 Agent 协作插件（GPT5.6 Sol 领队 / DeepSeek 双档执行）实现计划

## Context

在 `D:/Github projects/pi-dev/multi-agent`（空项目，将作为 git repo 根）开发一个 pi 包，实现三角色多 agent 协作，最大化利用不同模型能力并节省上下文/token：

| 角色 | 模型 | 职责 |
|------|------|------|
| 领导者/规划者 | GPT5.6 Sol | 需求澄清、架构设计、任务规划编排；**不做机械简单任务** |
| 深度研究者/红队 | DeepSeek V4 Pro | 深度研究派发的问题；对领导者设计方案 challenge |
| 执行者 | DeepSeek V4 Flash | 执行简单机械任务 |

硬性要求：可快速在不同机器的 pi 间迁移（假设模型在其他机器可用）；用户可在各机器上方便地为每个角色选择模型提供方（从该机器 pi 可用的模型中选）。

## 已确认的决策

1. **领导者 = 主会话本身**：用户以 GPT5.6 Sol 启动 pi，或用 `/team` 命令切换模型并激活协作模式。需求澄清/用户交互零损耗，不经过二跳转发，最省 token。
2. **硬依赖 pi-subagents 扩展**：复用其成熟的 spawn/模型绑定/工具白名单/异步编排机制；本包只做「角色定义 + 编排协议 + 激活命令」。
3. **私有 git repo 分发**：任意机器 `pi install git:github.com/<user>/multi-agent` 一步安装；更新走 `pi update --extensions`。
4. **显式命令激活**：`/team` 激活协作模式；日常简单任务不受干扰。

## 调研结论（支撑方案的关键事实）

- pi-subagents 已装（settings.json packages），其 `subagent` 工具支持 agent 角色选择、模型覆盖、workflowScript 编排、异步运行
- **自定义 agent = 带 YAML frontmatter 的 markdown 文件**；pi-subagents 会扫描已安装 pi 包的 `package.json` → `pi-subagents.agents`（或 `pi.pi.subagents.agents`）声明的 agent 目录 → agent 定义可随本包分发，无需拷贝到 `~/.pi/agent/agents/`
- agent frontmatter 支持 `model`（默认模型）+ `fallbackModels`（provider 故障/无 key/配额时按序回退）——DeepSeek 系列在 `deepseek`/`opencode-go`/`qwen-token-plan` 三个 provider 下都存在，fallback 链作为默认兜底；**用户侧的显式提供方选择**由 `/team-models` 命令提供（见「详细设计 5」），写入 settings 的 `subagents.agentOverrides.<name>.model`（pi-subagents 原生生效）
- settings 的 `subagents.agentOverrides.<name>.model` 提供用户级模型覆盖（不改包文件），作为跨机器手工修正手段
- `pi.setModel(model)`（ExtensionAPI）可在命令中切换主会话模型 → `/team` 可一键切到 GPT5.6 Sol
- skill 机制是 progressive disclosure：只有 description 常驻上下文，SKILL.md 按需加载 → 编排协议对上下文占用极小
- researcher 需要的 web 工具（web_search/fetch_content/get_search_content）来自已装的 pi-web-access 包，agent tools 白名单直接引用即可

## 包结构

```
multi-agent/                          # git repo 根
├── package.json                      # pi manifest（skills + extensions + subagents.agents）
├── agents/
│   ├── deep-researcher.md            # DeepSeek V4 Pro；只读+web；产出研究简报
│   ├── challenger.md                 # DeepSeek V4 Pro；只读；红队审查设计
│   └── executor.md                   # DeepSeek V4 Flash；写手；机械任务
├── skills/
│   └── team-orchestration/
│       ├── SKILL.md                  # 编排协议主体
│       └── references/
│           ├── task-packets.md       # 任务包/上下文蒸馏规范
│           └── workflows.md          # workflowScript 编排配方（challenge循环/研究fan-out/执行批次）
├── extensions/
│   └── index.ts                      # /team 与 /team doctor 命令
└── README.md                         # 安装迁移指南
```

## 详细设计

### 1. `agents/deep-researcher.md`

```yaml
---
name: deep-researcher
description: 深度研究（DeepSeek V4 Pro）——对领导者派发的研究问题做多源调研并产出结构化研究简报
tools: read, grep, find, ls, web_search, fetch_content, get_search_content
model: deepseek/deepseek-v4-pro
fallbackModels: opencode-go/deepseek-v4-pro, qwen-token-plan/deepseek-v4-pro
thinking: high
acceptanceRole: read-only
systemPromptMode: replace
inheritProjectContext: false
---
（中文 system prompt：研究方法论、多源交叉验证、引用来源、按固定结构输出研究简报：
结论先行 / 证据与来源 / 与问题的映射 / 风险与未知 / 建议下一步）
```

### 2. `agents/challenger.md`

```yaml
---
name: challenger
description: 设计挑战者/红队（DeepSeek V4 Pro）——对领导者的设计方案做对抗性审查
tools: read, grep, find, ls
model: deepseek/deepseek-v4-pro
fallbackModels: opencode-go/deepseek-v4-pro, qwen-token-plan/deepseek-v4-pro
thinking: high
acceptanceRole: read-only
systemPromptMode: replace
inheritProjectContext: true        # 需要看到项目上下文才能有效 challenge
---
（中文 system prompt：对抗性审查契约——攻击假设、找遗漏边界条件、质疑技术选型、
评估风险；按严重度分级输出 findings（critical/major/minor）；只批不改，
给出可执行的修改建议；明确说"通过"或"不通过"及理由）
```

### 3. `agents/executor.md`

```yaml
---
name: executor
description: 执行者（DeepSeek V4 Flash）——执行已规划好的机械简单任务
model: deepseek/deepseek-v4-flash
fallbackModels: opencode-go/deepseek-v4-flash, qwen-token-plan/deepseek-v4-flash
inheritProjectContext: true
---
（中文 system prompt：严格执行任务包，不做设计决策；发现任务包有歧义/缺信息时
上报而非猜测；完成后输出变更清单+验证结果；tools 省略=正常内置工具集）
```

### 4. `skills/team-orchestration/SKILL.md`（编排协议核心）

Frontmatter：`name: team-orchestration`，`description` 明确「/team 激活后的多agent协作编排协议：路由、任务包构造、challenge 循环、研究 fan-out」。

正文要点：
- **角色路由表与各角色「做/不做」契约**：

  | 角色 | 做 | 不做 |
  |------|----|------|
  | 领导者（主会话 Sol） | 需求澄清、架构决策、任务拆解编排、challenge 裁决与收敛、最终验收、用户沟通 | 不亲自写批量机械代码；不亲自做多源检索；不代替 executor 跑测试循环 |
  | deep-researcher | 多源调研、交叉验证、产出带来源的研究简报 | 不给最终架构裁决；不改任何代码；不做泛泛综述（必须回答派发的具体问题） |
  | challenger | 攻击假设、找遗漏边界、质疑选型、分级 findings、给可执行修改建议 | 不改代码/文档（只批不改）；不重写方案（建议而非替代）；不做礼貌性放水（必须有明确通过/不通过结论） |
  | executor | 严格按任务包实现、跑测试验证、输出变更清单 | 不做设计决策；不擅自扩展需求范围；遇到歧义上报领导者而非猜测 |

- **领导者禁做清单**：不亲自写批量机械代码、不亲自做多源检索（避免烧 Sol 的 token 和上下文）
- **任务包规范**（引用 references/task-packets.md）：派发时必须蒸馏上下文——目标、约束、相关文件路径清单、验收标准；禁止把整段对话历史粘给子 agent；子 agent 用 fresh context
- **标准流程**：
  - 功能开发流：澄清 → 领导者出设计 → challenger 审（默认必审，≤2 轮收敛；琐碎设计可跳过并在输出中声明理由）→ 拆任务包 → executor 批量执行（workflowScript `runs.all` 并行）→ 领导者验收
  - 研究流：拆子问题 → `runs.all` 并行 fan-out deep-researcher → 领导者综合
- **workflowScript 配方**（引用 references/workflows.md）：可直接抄的脚本模板（含 stable key、结果聚合）
- **升级规则**：子 agent 报告歧义/超权限决策 → 回到领导者裁决，不自行猜测

### 5. `extensions/index.ts`（/team、/team-models、/team-doctor 命令）

**`/team`**：
1. 读模型配置：`~/.pi/agent/team.config.json`（可选，字段 `leaderModel`；缺省 `openai-codex/gpt-5.6-sol`）
2. `ctx.modelRegistry.find(...)` 解析 leader 模型 → `pi.setModel(model)`；失败则 notify 并中止
3. 体检：`pi.getAllTools()` 确认 `subagent` 工具存在（否则提示需装 pi-subagents）；确认 web 工具存在（否则提示研究员降级）
4. `pi.sendUserMessage("/skill:team-orchestration", { deliverAs: "followUp" })` 自动加载编排协议，激活完成

**`/team-models`（用户侧提供方选择）**：
1. 对每个角色（leader/researcher/challenger/executor），扫描 `ctx.modelRegistry` 可用模型中与该角色基础模型 id 匹配的条目（如所有 provider 下的 `deepseek-v4-pro`），加上「自动（默认+fallback 链）」选项
2. `ctx.ui.select` 逐角色交互选择（无 UI 的模式下打印候选项与当前值）
3. 子 agent 的选择写入用户 settings 的 `subagents.agentOverrides.<name>.model`（JSON 安全合并写入 `~/.pi/agent/settings.json`；pi-subagents 原生读取，即时生效）；leader 的选择写入 `team.config.json` 的 `leaderModel`
4. 选「自动」则删除对应 override，恢复包内默认 + fallback 链

**`/team-doctor`**：逐项检查 leader/child 模型可解析且 API key 可用（含 agentOverrides 生效后的实际解析结果）、agents 已被 pi-subagents 发现、pi-web-access 存在；输出迁移体检报告
- `peerDependencies` 声明 `@earendil-works/pi-coding-agent`、`typebox`（`*`，不 bundle）

### 6. `package.json`

```json
{
  "name": "pi-multi-agent-team",
  "private": true,
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions/index.ts"],
    "skills": ["./skills"],
    "subagents": { "agents": ["./agents"] }
  }
}
```

### 7. `README.md`（迁移指南）

新机器三步：
1. `pi install npm:pi-subagents npm:pi-web-access`（若未装）
2. `pi install git:github.com/<user>/multi-agent`
3. 运行 `/team-models` 为各角色选择本机的模型提供方（或依赖自动 fallback 链）；`/team-doctor` 验证

## 实现步骤

> 注：计划批准后先保存并暂停，等待用户切换到合适的模型再开始实现。

- [x] **Step 0**：批准后保存计划，暂停等待用户切换模型 ✓
- [x] **Step 1**：初始化 repo：`git init`、`package.json`（pi manifest）、目录骨架 ✓
- [x] **Step 2**：编写三个 agent 定义（agents/*.md，中文 system prompt，frontmatter 按 above 设计） ✓
- [x] **Step 3**：编写 `skills/team-orchestration/SKILL.md` + `references/task-packets.md` + `references/workflows.md` ✓
- [x] **Step 4**：编写 `extensions/index.ts`（/team、/team-doctor 命令，模型解析与切换，体检逻辑） ✓
- [x] **Step 5**：编写 README.md（安装、迁移、跨机器模型修正说明） ✓
- [x] **Step 6**：本地安装验证（`pi install <本地路径>`），推送到私有 GitHub repo ✓（repo: CloudFan-cyf/pi-multi-agent-team）
- [ ] **Step 7**：允许用户为三个 agent 指定任意 pi 可用模型（详细设计见下「Step 7 详细设计」）：扩展 `/team-models` 候选范围 + 参数形式，验证后 commit + push
- [ ] **Step 8**：端到端演练（见 Verification）——暂停：等待 GPT5.6 Sol 可用后执行

### Step 7 详细设计：任意模型指定

需求：允许用户为三个子 agent（deep-researcher / challenger / executor）任意指定 pi 可用的模型名和 provider，不再局限于角色基础模型 id 的 provider 变体（例如 challenger 用 `openai-codex/gpt-5.6-luna`、executor 用 `opencode-go/qwen3.7-max`）。领导者 `leaderModel`（team.config.json）本就接受任意 spec，无需改动。

变更点（均在 `extensions/index.ts` 的 `/team-models` 命令）：

1. **交互模式候选列表**（TUI）：与 `/model` 命令同体验的纯列表选择，不引入自由输入。每个角色的 `ctx.ui.select` 候选改为：
   - `自动（默认+fallback 链）`
   - 基础模型变体（排最前，标注「推荐」——按角色定位预设的档位）
   - 其余全部 `getAvailable()` 模型（按 provider 分组排序，格式 `provider/model  (无 API key)` 标注 auth 状态）
   全量选择基于 `ctx.modelRegistry.getAvailable()`，列表项数在本机约 40+，`ctx.ui.select` 可直接支持
2. **选择后写入**：仍写 `subagents.agentOverrides.<agent>.model`，复用现有 `writeAgentOverride()` / `currentOverride()`，零新机制；选「自动」清除 override
3. **参数形式**（无 UI / 脚本化迁移）：`/team-models <agent> <spec|auto>` 直接设置，如 `/team-models executor opencode-go/qwen3.7-max`、`/team-models challenger openai-codex/gpt-5.6-luna`；spec 用 `findModel()` 校验（仅列表合法项，含 `:thinking` 后缀剥离）；参数不合法时报错并列出可用 agent 名
4. **`/team-doctor` 适配**：解析展示时剥离 `:thinking` 后缀再 findModel（其余逻辑已天然支持任意 spec）

验证：jiti 加载测试；`pi -p '/team-models executor opencode-go/qwen3.7-max'` 写入 override、`auto` 清除、非法 spec 报错；`/team-doctor` 正确显示 override；`subagent {action:"list"}` 反映新模型；`pi -p '/team-models'`（无 UI 无参数）打印当前值 + 全量可用模型清单。README 同步更新命令文档。能力适配提醒：agent 的 system prompt 是角色契约，换任意模型后仍成立；但 researcher/challenger 角色建议配推理较强的模型（非推理模型 thinking 会被 pi clamp 为 off），弱模型会降低研究/审查质量。

## Verification

1. **安装与发现**：`pi install <repo>` 后启动 pi；`subagent({action:"list"})` 应列出 `deep-researcher`/`challenger`/`executor` 三个 agent 且带模型信息
2. **/team 命令**：执行后主会话模型切到 `openai-codex/gpt-5.6-sol`，follow-up 自动加载 team-orchestration skill；缺 pi-subagents 时给出正确提示（可用 `-e` 临时禁用扩展模拟）
3. **/team-models**：交互列表正确展示各角色在本机可用的提供方变体；选择后 `subagent({action:"list"})` 反映 override；选「自动」能清除 override；**任意模型指定**：`/team-models <agent> <spec>` 参数形式写入任意 provider/model，`/team-doctor` 正确显示
3. **/team-doctor**：模型/agent/工具逐项体检输出
4. **端到端功能流**（在 scratch 项目中给一个真实功能需求）：
   - 验证领导者做了澄清和设计而非亲自写码
   - challenger 被调用且产出分级 findings，challenge 循环 ≤2 轮收敛
   - executor 以 `deepseek-v4-flash` 实际执行了文件修改（`subagent({action:"status"})` 核对子 run 的模型）
   - 研究问题 fan-out 到 deep-researcher 且有来源引用
5. **上下文经济**：检查任务包不含整段对话转储；主会话 token 消耗对比不启用协作时的合理下降
6. **迁移模拟**：删除本地安装，从 git repo 重新 `pi install`，重复 1–2 验证

## 风险与备注

- `fallbackModels` 只在 provider 故障（无 key/配额/超时）时触发；用户想主动选提供方（如成本考虑强制走中转）时用 `/team-models` 显式指定，写入 agentOverrides——README 已覆盖
- 各 agent 的 system prompt 中同样写入该角色的「做/不做」契约（与 SKILL.md 中表格一致），确保子 agent 侧也受约束
- challenger `inheritProjectContext: true` 会带入项目 AGENTS.md，token 略增但红队质量显著更好；executor 同理
- Sol 模型 ID 若未来在其他机器走不同 provider，改 `team.config.json` 的 `leaderModel` 一处即可
