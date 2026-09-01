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
pi install git:github.com/CloudFan-cyf/pi-multi-agent-team

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

激活后，主会话即按编排协议工作：设计必经 challenger 审查（≤2 轮收敛）、研究问题 fan-out 给 researcher、独立域任务包可用各自的顶层 async workflow 并行执行；每个 executor 完成先提醒领导者，再进入独立 reviewer 评审门。

### `/team-models` — 角色模型选择

两级导航（避免长列表溢出终端/浏览器视口）：每个角色先选「默认档位」或「按 provider 选模型」；选后者则先选 provider（如 deepseek/opencode-go/...，每层仅数项），再选该 provider 下的模型（每层仅 3–10 项），不再一次列出全部 40+ 模型。

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

### `/team-fallback` — fallback 链管理

子 agent 的 fallback 链（provider 故障时按序回退）现在可由用户配置（包内 frontmatter 不再写死，默认链由包物化为 override）。

**参数形式**（主）：

```
/team-fallback <agent> <spec1> [spec2] [spec3]...   # 设整链（按序回退）
/team-fallback <agent> default                       # 重置为包默认链
/team-fallback <agent> clear                         # 清除（无 fallback）
/team-fallback <agent> show                          # 显示当前链

示例：
/team-fallback executor opencode-go/deepseek-v4-flash qwen-token-plan/deepseek-v4-flash
```

每个 spec 对照本机可用模型校验，非法时报错。**交互形式**（无参数）逐角色提供：保留当前 / 重置为默认 / 清除 fallback；列表增删重排交给参数形式。

`clear` 会持久化为 pi-subagents 原生的 `fallbackModels: false`（而不是删除字段），因此后续 `/team`、`/team-doctor` 不会重新物化默认链。`/team-doctor` 会显示并验证每个 fallback 模型；链中含已删除/改名的 provider 时会标红。默认链只物化本机实际可用的模型，历史 `qwen-token-plan/*` 会自动迁移为 `qwen-token-plan-cn/*`（若新模型存在）。

> 能力适配提醒：agent 的 system prompt 是角色契约，换任意模型后仍然成立；但 deep-researcher / challenger 角色建议配推理能力较强的模型（非推理模型的 thinking 会被 pi 自动 clamp 为 off），弱模型会明显降低研究/审查质量。

### `/team-doctor` — 环境体检

逐角色检查：override 生效后的模型可解析、API key 可用；`subagent` / web 工具存在；skill 被系统发现。输出迁移体检报告。

## 团队可视化

`/team` 激活后，当前会话的 Leader 与各子 agent 会以紧凑状态视图投影到 TUI 右侧
overlay 与 stock pi-web 的 Extension Widget（无需修改 pi-web 源码）：

```text
/team-panel auto   # 有团队活动时显示（默认）
/team-panel show   # 始终投影当前会话团队状态
/team-panel hide   # 清除 overlay/status/widget
```

- **TUI**：宽终端（≥110 列）显示右侧非抢焦点 overlay；窄终端降级为单行状态摘要。
- **stock pi-web**：使用编辑器附近的 Extension Widget（`placement: aboveEditor`）展示
  详情，footer 常驻单行 `◆ Team …` 摘要；列表超过约 3 行时 Widget 可能折叠为 trigger，
  需点击展开，该行为由 stock `ExtensionWidgets` 控制，本包不伪造展开状态、也不提供
  右侧栏或原生卡片 DOM。
- **本地预览的持久化/安全注意**：成员 title/preview 会持久化到用户级本地目录
  `~/.pi/agent/team-status/v1/`（Unix 下目录/文件尽力 `0o700`/`0o600`）；best-effort
  凭据脱敏**不是安全保证**，Windows 下依赖用户目录继承 ACL，不要在网络可访问目录
  运行或把该目录当作审计/消息队列/安全边界。
- **父进程退出限制**：拥有任务的父 Pi 进程退出后，仍在运行的 detached child 不被
  v1 继续追踪；旧 shard 会先变 stale 再消失，不承诺跨全新父会话恢复投影。

本地/半自动验证 fixture（写入一个活的 Leader+Executor shard，退出时自清理）：

```bash
node --experimental-strip-types scripts/write-team-status-fixture.mjs \
  --agent-dir "$HOME/.pi/agent" \
  --session-id "<与 pi-web 会话一致的 id>" \
  --duration-ms 60000
```

完整手工验证清单见 `docs/team-visualization-validation.md`。

## 子 Agent 续作与任务板

多轮团队工作（初次执行 → 评审 → 裁决 → 修复 → 复审 → 验收）跨多个 workflow，靠
pi-subagents 的 **async workflow + mission** 能力续作，**不新增任何运行时依赖**：

- **多轮工作 = async workflow + mission**：首个 workflow 用 `mission: {...}` 创建 mission 并捕获
  `details.missionId`；后续每轮 workflow 显式传同一 `missionId`，用 `state.get` / `state.set` 读写
  `lane.<laneKey>` 状态；任务板 = state 里的 `{version, laneKeys}` 索引，只登记 lane 存在性，
  phase/runId 等可变状态唯一事实源是 `lane.<laneKey>`（不复制，防双份漂移；mission.show 是它的外部投影）。
  续作 lane 用 `isolation: none`（共享 cwd），不使用 worktree 隔离。
- **进程结束但会话可恢复**：workflow 结束后，child 会话文件、terminal async workflow 的
  `workflow-receipt.json`（keyed receipt）与 mission state 都持久化在磁盘；同一持久父会话可基于
  receipt / runId 续作原 child，不丢上下文。
- **恢复策略：receipt-first**：优先 terminal async workflow 的 receipt 做 keyed resume
  （`resume: { workflowRunId, key, latest: true }`）→ 同父会话用 `latestRunId` 直接 resume →
  `children.list` 仅诊断（未列出 ≠ 不可恢复，它最多显示最近 10 个 retained children）→ 只有明确
  证明 stopped / 会话或 cwd 缺失 / receipt 不存在时才 fresh fallback（完整重建包，不是 delta 包）。
- **resume 沿用原模型/工具契约**：`resume` 与 `agent` 互斥，续作保留原 agent、模型、工具配置，
  不换角色；resume item 不接受 `gate`。
- **不承诺任意新父会话可恢复**：恢复路径限定在**同一持久父会话 + 同一 mission**；跨全新独立
  父会话的恢复遵循 pi-subagents 当前的所有权/会话约束，不做额外保证。

- **任务包双模式**：无计划时继续使用目标/约束/相关文件/验收标准四要素任务包；有计划时任务包必须绑定计划原生执行单元，不能再次任意切片或扩张。
- **Superpowers 对齐**：`superpowers:writing-plans` 计划中的一个完整 `### Task N` 对应一次 executor 执行与一次 task-scoped reviewer；Task 内 Steps 由同一 executor 顺序完成，精确要求通过 `task-brief` 交付。
- **机械就绪门**：缺少精确文件、操作、验证或仍需设计判断的计划单元返回领导者，不通过扩大 executor 职责来强行执行。
- **逐 subagent 完成提醒**：executor、reviewer、fix、re-review 分别结束顶层 async workflow；每个角色完成后领导者都会收到 completion wake，核验当前结果与 lane phase 后再启动下一阶段。
- **评审门仍强制**：拆分 workflow 只改变提醒边界，不取消 executor 后的 fresh reviewer，也不允许失败 executor 进入评审。

编排协议细节见 `skills/team-orchestration/SKILL.md`「编排状态与恢复」，配方与任务包模板见
`skills/team-orchestration/references/`。

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
│           ├── task-packets.md  # 通用/计划对齐任务包，以及初次/续作/重建三形态
│           └── workflows.md     # 分阶段 workflowScript 配方（逐角色通知、resume 续作与恢复索引）
├── extensions/
│   └── index.ts                 # /team /team-models /team-fallback /team-doctor
└── package.json                 # pi manifest
```

## 跨机器注意事项

- **provider 差异**：包内默认模型绑定带 fallback 链，覆盖常见 provider 变体；非标准 provider 或想换任意模型（如给 executor 换更快的档位）用 `/team-models` 选择（本质是写 `subagents.agentOverrides`）
- **API key**：各机器的 provider 认证在 pi 侧配置（`pi` 登录流程或 `models.json`），与包无关；`/team-doctor` 会暴露缺 key 的角色
- **领导者模型**：若某机器的 Sol 经不同 provider 提供，改 `~/.pi/agent/team.config.json` 的 `leaderModel`（或 `/team-models` 里选）即可
- agent override 改动后建议重启 pi（或 `/reload`）以确保 pi-subagents 重新读取

## 安全说明

本包不含可执行安装脚本；扩展代码仅做模型切换、settings JSON 合并与命令注册。子 agent 的实际权限由 pi-subagents 的工具白名单控制（researcher/challenger 为只读，executor 为正常内置工具集）。

## License

[MIT](./LICENSE)
