# pi-multi-agent-team

多 Agent 协作团队插件，为 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 提供三角色协作模式，最大化利用不同模型的能力并节省主会话上下文与 token：

| 角色 | 模型 | 职责 |
|------|------|------|
| 领导者/规划者 | GPT5.6 Sol（主会话） | 需求澄清、架构设计、任务拆解编排、challenge 裁决、最终验收 |
| 深度研究员 | DeepSeek V4 Pro | 多源调研，产出带来源的研究简报 |
| 设计挑战者（红队） | DeepSeek V4 Pro | 对领导者设计方案做对抗性审查，输出分级 findings |
| 执行者 | DeepSeek V4 Flash | 严格按任务包执行机械任务并自行验证 |

架构：领导者即主会话（用户以 Sol 直接对话，无二跳转发）；三个子 agent 由 [pi-subagents](https://github.com/nicobailon/pi-subagents) 负责实际 spawn、上下文隔离与编排执行；本包提供角色定义（`agents/`）、编排协议（`skills/team-orchestration/`）与激活/管理命令（`extensions/index.ts`）。

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

## 命令

### `/team` — 激活协作模式

1. 将主会话模型切换到领导者模型（默认 `openai-codex/gpt-5.6-sol`）
2. 检查 `subagent` 工具与 web 工具可用性
3. 以 follow-up 形式自动加载 `team-orchestration` 编排协议 skill

激活后，主会话即按编排协议工作：设计必经 challenger 审查（≤2 轮收敛）、研究问题 fan-out 给 researcher、机械任务打包给 executor 并行执行。

### `/team-models` — 模型提供方选择

同一基础模型（如 `deepseek-v4-pro`）在不同机器可能经不同 provider 提供（官方 API、中转站等）。此命令为每个角色列出本机可用的 provider 变体（含 API key 状态），交互选择后：

- 子 agent 角色 → 写入 `~/.pi/agent/settings.json` 的 `subagents.agentOverrides.<agent>.model`（pi-subagents 原生生效，优先于包内默认）
- 领导者 → 写入 `~/.pi/agent/team.config.json` 的 `leaderModel`
- 选「自动」→ 清除 override，恢复包内默认 + fallback 链（deepseek → opencode-go → qwen-token-plan，仅 provider 故障时按序回退）

### `/team-doctor` — 环境体检

逐角色检查：override 生效后的模型可解析、API key 可用；`subagent` / web 工具存在；skill 被系统发现。输出迁移体检报告。

## 包结构

```
├── agents/                      # pi-subagents 角色定义
│   ├── deep-researcher.md       #   深度研究员（只读+web）
│   ├── challenger.md            #   设计挑战者（只读红队）
│   └── executor.md              #   执行者（写手）
├── skills/
│   └── team-orchestration/
│       ├── SKILL.md             # 编排协议：路由/流程/上下文经济/升级规则
│       └── references/
│           ├── task-packets.md  # 任务包构造规范（上下文蒸馏）
│           └── workflows.md     # workflowScript 编排配方
├── extensions/
│   └── index.ts                 # /team /team-models /team-doctor
└── package.json                 # pi manifest
```

## 跨机器注意事项

- **provider 差异**：包内默认模型绑定带 fallback 链，覆盖常见 provider 变体；非标准 provider 用 `/team-models` 显式指定（本质是写 `subagents.agentOverrides`）
- **API key**：各机器的 provider 认证在 pi 侧配置（`pi` 登录流程或 `models.json`），与包无关；`/team-doctor` 会暴露缺 key 的角色
- **领导者模型**：若某机器的 Sol 经不同 provider 提供，改 `~/.pi/agent/team.config.json` 的 `leaderModel`（或 `/team-models` 里选）即可
- agent override 改动后建议重启 pi（或 `/reload`）以确保 pi-subagents 重新读取

## 安全说明

本包不含可执行安装脚本；扩展代码仅做模型切换、settings JSON 合并与命令注册。子 agent 的实际权限由 pi-subagents 的工具白名单控制（researcher/challenger 为只读，executor 为正常内置工具集）。
