# Team 团队可视化 — 手工验证清单

本文档记录 stock pi-web / TUI 跨进程投影的手工 E2E 验证流程与实测结果。
自动化单测（`npm test`）覆盖 reducer / store / adapter / renderer / controller
的行为契约；本清单聚焦只有真实宿主进程才能验证的集成行为。

**前置**：本包已通过 Git package 安装（`~/.pi/agent/settings.json` 的 `packages`
含 `git:ssh://...CloudFan-cyf/pi-multi-agent-team.git`）。验证时会把该条目临时换成
本地 worktree 绝对路径，验证后**必须恢复**（见 Gate 9）。

## 验证门

1. 备份 `~/.pi/agent/settings.json`。
2. 将已安装 Git package 条目临时替换为本地 worktree 绝对路径；测试后恢复备份。
3. 重启 stock pi-web 并调用 `POST /api/agent/<session-id>`（`{"type":"get_commands"}`）；
   断言 `team-panel` 的 `source` 为 `"extension"` 且指向本地 package 路径。
4. 用同一 session id 启动 fixture；断言 Web footer 含 `◆ Team`，点击 `team-status`
   展开，能看到 Leader/Executor 标题与 preview。
5. 从同一 worktree 启动 TUI，运行 `/team`，派发一个 async `executor`，验证 overlay
   与 Web 更新且不抢焦点。
6. 完成/失败该 child，测量其卡片保留 30 ± 2 秒。
7. TUI 从 110 列缩到 109 列，验证详情隐藏而单行 status 仍显示。
8. 运行 `/reload`、切换会话、停止两个宿主；验证无残留 widget、无晚于 shutdown 的 shard。
9. 即使任一 gate 失败，也要恢复 settings 备份。

## 结果表

| Gate | Command/Evidence | Observed | Pass |
|---|---|---|---|
| 1 | `cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.task9-backup && sha256sum` | 原始/备份 sha256 均为 `9baef5b5…ad987868`，`diff` 为空，字节级一致 | ✅ |
| 2 | 用脚本将 `packages[]` 末项替换为 `D:\Github projects\pi-dev\multi-agent\.worktrees\team-visualization-impl`；`JSON.parse` 校验通过 | 替换后 `packages[]` 末项指向本地 worktree；其余条目未变 | ✅ |
| 3 | `pi-web --port 31099 --no-open`（独立端口，不动 30141）→ `POST /api/agent/new {"cwd":worktree,"type":"ensure_session"}` → `POST /api/agent/<sid> {"type":"get_commands"}` | `team-panel` 返回 `source:"extension"`，`sourceInfo.path=D:\…\.worktrees\team-visualization-impl\extensions\index.ts`，`source` 为本地 worktree 路径（非 git URL） | ✅ |
| 4 | fixture `--agent-dir ~/.pi/agent --session-id <同一 sid> --duration-ms 12000`；轮询 `get_state` | `extensionStatuses` 出现 `{"key":"team-status","text":"◆ Team · 1 leader · 2 running"}`；`extensionWidgets` 出现 `{"key":"team-status","lines":["◆ Leader · running","  Team fixture leader","","› Executor · running","  Fixture executor task","  Running fixture executor..."],"placement":"aboveEditor"}`；fixture 退出后 status/widget 均清空 | ✅ |
| 5 | TUI `/team` + async executor | 非交互 harness 无法观察真实 TUI overlay/焦点行为；派发 async executor 会触发真实 LLM 调用 | ⛔ NOT RUN |
| 6 | 终态卡片保留 30±2s | 需真实 child 完成 + 交互观察；reducer 的 30s terminal retention 已由 `reducer.test.mjs` 单测覆盖 | ⛔ NOT RUN |
| 7 | 110→109 列 resize | 需真实 TUI 宽度变化；`TUI_MIN_COLUMNS=110` 阈值已由 `tui-overlay.test.mjs` 单测覆盖 | ⛔ NOT RUN |
| 8 | `/reload` / 切会话 / 停宿主 | 非交互 harness 无法执行 `/reload` 与会话切换；「停止宿主无残留 shard」由 fixture `finally` 清理验证（`team-status/v1` 下 0 残留文件） | ⛔ NOT RUN（shard 清理已证） |
| 9 | 恢复 `settings.json` + `sha256sum` 校验 | 恢复后 sha256 重新等于 `9baef5b5…ad987868`，与备份字节级一致；备份与临时脚本已删除 | ✅ |

## 验证环境

- 平台：Windows（Git Bash / MSYS），Node v22.19.0。
- stock pi-web：`@agegr/pi-web@0.8.9`（独立端口 31099 启动，未触碰用户正在运行的 30141 实例）。
- 观察方式：pi-web 的 `get_state` RPC 返回 `extensionStatuses` / `extensionWidgets`，
  直接反映 `setStatus("team-status", …)` / `setWidget("team-status", …, {placement:"aboveEditor"})`
  投影结果；无需浏览器即可断言 footer 单行与 widget 详情内容。

## 未覆盖门的原因（诚实记录）

- **Gate 5–8 为真实 TUI 交互**：headless harness 无法观察 overlay 视觉呈现、焦点抢占、
  终端 resize、`/reload` 会话切换；强行派发 async executor 会消耗真实 LLM API 调用。
  这些行为已由 controller / tui-overlay / reducer 的集成与单测覆盖其可测部分
  （无抢焦点 `unfocus()`、`TUI_MIN_COLUMNS` 阈值、30s retention、shutdown 清理）。
- **Gate 4 的「点击 team-status」**：headless 环境无法真实点击浏览器 widget trigger，
  但 `extensionWidgets` 返回的 `lines` 内容即点击后展开的详情，已作为等价证据记录。

## 最终复审修复波（2026-08-27）

本轮为最终复审的单次修复波，仅处理两项：生产诊断可观测性（Finding 1）与
pi-web Agent adapter 契约审计（Finding 2）。本轮未尝试也未将 Gate 5–8 标记为 PASS——
它们是真实 TUI 交互的人工视觉门，仍保持 `⛔ NOT RUN` 待办；本轮未触碰用户 settings
（`~/.pi/agent/settings.json`），未启动/停止任何 pi-web 实例。

## pi-web 0.8.x 契约审计（受支持基线）

`extensions/team-status/pi-web-agent-adapter.ts` 的承载常量/字段名已对照只读上游
pi-web 源码 checkout（`D:/Github projects/pi-dev/pi-web`，`@agegr/pi-web@0.8.11`，
`package.json` 第 3 行）逐项核对，**全部匹配**，无需改动生产代码。以下为精确证据。

| Adapter 常量/字段 | 上游源码位置（文件:行） | 观察 |
|---|---|---|
| 工具名 `Agent` | `lib/subagent-extension.ts:111`（`name: "Agent"`） | ✅ 匹配 |
| 工具参数 `subagent_type` | `lib/subagent-extension.ts:122` | ✅ 匹配 |
| 工具参数 `prompt` | `lib/subagent-extension.ts:123` | ✅ 匹配 |
| 工具参数 `description` | `lib/subagent-extension.ts:128` | ✅ 匹配 |
| 工具参数 `run_in_background` | `lib/subagent-extension.ts:129` | ✅ 匹配 |
| details kind `pi-web-subagent` | `lib/subagent-extension.ts:21`（`SubagentToolDetails.kind`） | ✅ 匹配 |
| details `sessionId` | `lib/subagent-extension.ts:22` | ✅ 匹配 |
| details `profile` | `lib/subagent-extension.ts:23` | ✅ 匹配 |
| details `status` | `lib/subagent-extension.ts:25` | ✅ 匹配 |
| details `runInBackground`（camelCase） | `lib/subagent-extension.ts:26` | ✅ 匹配 |
| 后台通知自定义消息 `pi-web:subagent-notification` | `lib/subagent-runtime.ts:390`（`notifyParent` 内 `sendCustomMessage.customType`） | ✅ 匹配 |
| 通知 `content` | `lib/subagent-runtime.ts:391`（`subagentFinalText(run)`） | ✅ 匹配 |
| 通知 `details` | `lib/subagent-runtime.ts:393`（`subagentToolDetails(run)`） | ✅ 匹配 |

备注：

- 上游 `SubagentToolDetails` 还含 `description`/`createdAt`/`completedAt?`/`error?`
  （`lib/subagent-extension.ts:24,27,28,29`），adapter 仅在可读时使用 `profile`/`description`，
  其余按规格 §7.3 作为可选补充，字段缺失时降级为标题 + 状态，不解析 pi-web 内部 HTTP。
- `notifyParent` 的 `content` 是 `subagentFinalText(run)`（`lib/subagent-extension.ts:86-94`），
  对 `completed` 返回 `run.result`，因此 adapter 的 `notificationPreview` 直接读 `message.content`
  即可拿到终态文本，符合现有实现。
- 本轮未修改只读上游 checkout。

## 有界手动反馈修复波（2026-08-27）

### 实测发现（初检失败）

真实运行中，某 async workflow 子成员在 shard 中持久化为 `role=other`、
`agent=drivers-risk-fallback`、`preview=[Running web_search]`，而对应的有界 async
`status.json` step 实为 `agent=deep-researcher`、`label/workflowKey=drivers-risk-fallback`、
`model=gpt-5.6-sol`、`currentTool=web_search`、`recentOutput=[]`。

根因：`pi-subagents` 公开 `asyncSnapshot` 有意只暴露 `label` 而不暴露 `agent`/`model`；
当前 adapter 只读有界 `status.json` 拿 `recentOutput`，丢弃了 `agent`/`model`，导致
role 被错误降级为 `other`、model 缺失。

### 本轮修复（本 worktree）

- `TeamMemberStatusV1` 新增可选净化 `model`（≤ 96 字符，绝不持久化 thinking/敏感字段），v1 向后兼容。
- 单次有界 `status.json` 读取改为返回选中 step 的 `agent`/`model`/≤2 行净化 `recentOutput`
  （路径字面量、1 MiB 预检、childIndex 仅作 steps 索引、畸形/缺失 → 空投影，单次轮询不重复读）。
- async 优先取 artifact step `agent`/`model`，缺失回退公开 node `label`；该案例现在为
  `role=deep-researcher`、`agent=deep-researcher`、`model=gpt-5.6-sol`，title 仍用稳定 node `id`。
- foreground 从 progress/result DTO 填充 model，merge 在省略时保留 last-known model。
- TUI/Web 紧凑头行为 `{icon} {角色} · {state}[ · {model}]`；该阶段曾为 Web 注入 SGR，
  后续真实 0.8.9 复测证明宿主不解析 ANSI，已由下文「pi-web 0.8.9 ANSI 乱码修复波」
  的纯 emoji 方案取代。

### 复测状态（诚实记录）

- 自动测试已覆盖该真实形状 fixture 并转绿；真实 stock pi-web 0.8.9 的角色、模型与活动信息
  已在后续 emoji 修复后通过用户浏览器复测。TUI 焦点/resize/retention/cleanup 仍按 Gates 5–8
  的对应未覆盖项保留待办。
- 未触碰 `~/.pi/agent/settings.json`，未启动/停止任何 pi-web 进程，未改动只读上游 checkout。

## 位置不变量源码证据与 workflowKey 关联守卫（复审修复）

复审发现 async 成员的 role/agent/model 依赖**位置不变量**：
`status.json` 的 `steps[childIndex]` ↔ 公开 `asyncSnapshot` 的 `run.children[childIndex]`。
对安装的 pi-subagents 0.56.0 源码逐行核对，当前顺序确实有效：

| 证据 | 源码位置（安装包 0.56.0） | 观察 |
|---|---|---|
| 持久化把 `status.steps` 以 map 保持顺序拷入 `liveJob.steps` | `pi-subagents/src/runs/foreground/subagent-executor.ts:4518`（`liveJob.steps = status.steps.map((step, index) => ({ ...step, index }))`）；`:4519` 同步 `liveJob.agents` | ✅ 保持顺序 |
| 快照对 `job.steps` 用 map 保持顺序构建 step 子节点 | `pi-subagents/src/runs/background/async-status-snapshot.ts:214`（`job.steps?.map((step, index) => buildStepNode(step, step.index ?? index, 1, ctx))`） | ✅ 保持顺序，无重排 |
| 子节点按前缀截断（`maxChildrenPerNode`） | `async-status-snapshot.ts:147`（`children.push(...source.slice(0, remaining))`，`:217` 对 `[...stepChildren, ...nestedChildren]`） | ✅ 前缀截断，不重排 |
| 公开 step `node.id` 即 `workflowKey`（缺省 `runId`，再缺省 `step:N`） | `async-status-snapshot.ts:155` | ✅ 关联提示可验证 |

尽管如此，仍增加防御：`AsyncStepProjection` 携带净化后的可选 `workflowKey`（仅内存，
绝不写入 Team DTO）。仅对 step 节点做关联：当非空 `workflowKey` 与公开 node `id` 不一致
（合成 `step:N` id 因无真实 workflowKey 一律视为不一致，保守拒绝）时，丢弃整份 artifact
投影，回退到公开 node `label`/`currentTool`；childless 根节点（subagent/workflow）与关联提示
缺失时仍接受已验证的位置不变量（兼容旧/plain run 形状）。root 回退富集路径不变。

Gate 5–8 与真实 TUI/stock pi-web 复测仍保持 **⛔ PENDING RE-TEST**，未标记为 PASS。

## pi-web 0.8.9 ANSI 乱码修复波（2026-08-27）

### 0.8.9 根因（只读证据）

stock pi-web 0.8.9 的 `package.json`（`C:/Users/ChenYunfan/AppData/Roaming/npm/node_modules/@agegr/pi-web/package.json`）
版本为 `0.8.9`，依赖不含 `ansi_up`；其 `.next` 构建产物中也搜不到 `AnsiText` 组件，
`ExtensionWidgets` 直接以纯文本透传 `setWidget` 的 lines。因此此前 Web 头行注入的有界
标准 SGR（`\x1b[..m`）会原样显示为乱码。

上游 0.8.11 checkout（`D:/Github projects/pi-dev/pi-web`，`package.json` 第 3 行
`"version": "0.8.11"`）的 `components/ExtensionWidgets.tsx:134` 才使用 `AnsiText` 渲染
widget 内容；但扩展不依赖该能力。

### 修复

仅 Web Widget（`extensions/team-status/web-widget.ts`）移除 ANSI SGR，改用用户批准的
emoji + 状态 emoji：

- 角色：👑 Leader / 🔍 Researcher / ⚔️ Challenger / ⚙️ Executor / ✅ Reviewer / 🤖 Other；
- 状态：⚪ idle / 🔵 starting / 🟢 running / ✅ completed / 🔴 failed / ⚫ stopped / 🟡 stale；
- 紧凑头部：`{角色emoji} {Role} · {状态emoji} {state}[ · {model}]`，无 model 时无尾随分隔符；
- 任意 widget 输出行均不含 ESC/C0/C1 控制码；status summary 保持纯文本现状。

TUI overlay（`extensions/team-status/tui-overlay.ts`）继续使用宿主 Theme 语义色，其角色映射
（◆ ⌕ ! › ✓ •）与生命周期未改动。

### 复测状态（诚实记录）

- 自动测试（`npm test`）已新增精确 emoji 映射、含/不含 model 头部、无控制码断言并转绿。
- **stock pi-web 0.8.9 浏览器复测 ✅ PASS（用户实测）**：执行 `/reload`、`/team` 后，
  Widget 乱码消失，角色等成员信息显示正确。
- 0.8.11 浏览器复测、30±2 秒终态保留、110→109 resize、`/reload`/会话切换清理仍为
  **⛔ PENDING RE-TEST**。本轮未修改 pi-web / pi-subagents 或外部只读 checkout。
