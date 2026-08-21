# pi-multi-agent-team

多 Agent 协作团队插件，为 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 提供三角色协作模式，最大化利用不同模型的能力并节省主会话上下文与 token：

| 角色 | 模型 | 职责 |
|------|------|------|
| 领导者/规划者 | GPT5.6 Sol（主会话） | 需求澄清、架构设计、任务拆解编排、challenge 裁决、最终验收 |
| 深度研究员 | DeepSeek V4 Pro | 多源调研，产出带来源的研究简报 |
| 设计挑战者（红队） | DeepSeek V4 Pro | 对领导者设计方案做对抗性审查，输出分级 findings |
| 执行者 | DeepSeek V4 Flash | 严格按任务包执行机械任务并自行验证 |
| 代码评审员 | DeepSeek V4 Flash | 对执行者产出做只读评审（分级 findings + verdict），每次执行后的强制评审门 |

架构：领导者即主会话（用户以 Sol 直接对话，无二跳转发）；四个子 agent 由 [pi-subagents](https://github.com/nicobailon/pi-subagents) 负责实际 spawn、上下文隔离与编排执行；本包提供角色定义（`agents/`）、编排协议（`skills/team-orchestration/`）与激活/管理命令（`extensions/index.ts`）。

## 前置依赖

- pi（coding agent）
- `pi-subagents`：子 agent 执行底座（agent 定义也经其加载）
- `pi-web-access`：提供 `web_search` / `fetch_content`（deep-researcher 的外部调研能力；缺失时仅该角色降级，其余功能不受影响）

## 安装（新机器三步迁移）

```bash
# 1. 底座依赖（若未装）
pi install npm:pi-subagents
pi install npm:pi-web-access

# 2. 本包（私有 git repo）
pi install git:github.com/<you>/pi-multi-agent-team

# 3. 体检 + 选择本机模型提供方
#    在 pi 中运行：
#      /team-doctor    环境体检
#      /team-models    为各角色选择本机可用的模型提供方
```

更新：`pi update --extensions`。卸载：`pi remove git:github.com/<you>/pi-multi-agent-team`。

> **网络受限机器（github.com 443 被阻断）的安装法**：可用 SSH over 443 安装：
> ```bash
> pi install 'ssh://git@ssh.github.com:443/<you>/pi-multi-agent-team.git'
> ```
> 然后把 `~/.pi/agent/settings.json` 中该包条目改写为 `git:ssh://git@ssh.github.com:443/<you>/pi-multi-agent-team.git`（加 `git:` 前缀）。原因：pi 本身接受裸 URL 条目，但 pi-subagents 的包级 agent 发现只解析 `git:`/`npm:`/路径形式的条目；普通机器用 `pi install git:github.com/...` 安装的条目天然带 `git:` 前缀，无需此步。

## 命令

### `/team` — 激活协作模式

1. 将主会话模型切换到领导者模型（默认 `openai-codex/gpt-5.6-sol`）
2. 检查 `subagent` 工具与 web 工具可用性
3. 以 follow-up 形式自动加载 `team-orchestration` 编排协议 skill

> 注意：模型切换使用 pi 的 `setModel`，它会同步写入全局 `defaultModel`（即 `/team` 会把 pi 默认模型改为领导者模型）。不希望长期生效时，可用 `pi -m <model>` 启动参数或 `/model` 命令改回。

激活后，主会话即按编排协议工作：设计必经 challenger 审查（≤2 轮收敛）、研究问题 fan-out 给 researcher、独立域任务包并行派给 executor（runs.all）、每个执行后必经 reviewer 评审门（执行汇报与评审报告一起呈交领导者）。

### `/team-models` — 角色模型选择

与 `/model` 同体验的纯列表选择：为每个角色（含领导者）依次弹出选择列表，候选 = `默认档位`（角色预设模型 + fallback 链）→ 推荐变体 → 其余全部本机可用模型（按 provider 排序、标注 API key 状态）。选任意模型均可。

选择后写入：

- 子 agent 角色 → `~/.pi/agent/settings.json` 的 `subagents.agentOverrides.<agent>.model`（pi-subagents 原生生效）
- 领导者 → `~/.pi/agent/team.config.json` 的 `leaderModel`

> **机制说明**：包内 agent frontmatter 不声明 `model`（这是 pi-subagents 的 override 生效前提），因此首次运行任意 team 命令（`/team`、`/team-models`、`/team-doctor`）时会把三个角色的默认档位自动物化为 settings 中的 override；「默认档位」选项 = 写回预设 spec（如 `deepseek/deepseek-v4-flash`），不是清除。手工删除 override 会使 agent 回退为继承会话模型，重新运行任意 team 命令即可恢复。

**参数形式**（无 UI / 脚本化迁移，仅三个子 agent）：

```
/team-models <agent> <provider/model|default>

示例：
/team-models executor opencode-go/qwen3.7-max
/team-models challenger openai-codex/gpt-5.6-luna
/team-models deep-researcher default
```

spec 会对照本机可用模型校验，非法时报错并提示用 `pi --list-models` 查询。`default` = 写回角色预设档位。

> 能力适配提醒：agent 的 system prompt 是角色契约，换任意模型后仍然成立；但 deep-researcher / challenger 角色建议配推理能力较强的模型（非推理模型的 thinking 会被 pi 自动 clamp 为 off），弱模型会明显降低研究/审查质量。

### `/team-doctor` — 环境体检

逐角色检查：override 生效后的模型可解析、API key 可用；`subagent` / web 工具存在；skill 被系统发现。输出迁移体检报告。

## 包结构

```
├── agents/                      # pi-subagents 角色定义
│   ├── deep-researcher.md       #   深度研究员（只读+web）
│   ├── challenger.md            #   设计挑战者（只读红队）
│   ├── executor.md              #   执行者（写手）
│   └── reviewer.md              #   代码评审员（只读评审，强制评审门）
├── skills/
│   └── team-orchestration/
│       ├── SKILL.md             # 编排协议：路由/流程/评审门/并行纪律/升级规则
│       └── references/
│           ├── task-packets.md  # 任务包构造规范（含评审任务包）
│           └── workflows.md     # workflowScript 编排配方（含执行+评审门）
├── extensions/
│   └── index.ts                 # /team /team-models /team-doctor
└── package.json                 # pi manifest
```

## 跨机器注意事项

- **provider 差异**：包内默认模型绑定带 fallback 链，覆盖常见 provider 变体；非标准 provider 或想换任意模型（如给 executor 换更快的档位）用 `/team-models` 选择（本质是写 `subagents.agentOverrides`）
- **API key**：各机器的 provider 认证在 pi 侧配置（`pi` 登录流程或 `models.json`），与包无关；`/team-doctor` 会暴露缺 key 的角色
- **领导者模型**：若某机器的 Sol 经不同 provider 提供，改 `~/.pi/agent/team.config.json` 的 `leaderModel`（或 `/team-models` 里选）即可
- agent override 改动后建议重启 pi（或 `/reload`）以确保 pi-subagents 重新读取

## 安全说明

本包不含可执行安装脚本；扩展代码仅做模型切换、settings JSON 合并与命令注册。子 agent 的实际权限由 pi-subagents 的工具白名单控制（researcher/challenger 为只读，executor 为正常内置工具集）。
