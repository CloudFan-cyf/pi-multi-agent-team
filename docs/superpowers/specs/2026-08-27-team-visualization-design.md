# Team 团队可视化设计规格

**日期：** 2026-08-27  
**状态：** 已获用户批准并完成两轮设计挑战  
**范围：** 仅修改 `pi-multi-agent-team`；不修改 `pi-subagents`、`pi-mono` 或 `pi-web`

## 1. 背景

Team 模式可以派发 `deep-researcher`、`challenger`、`executor`、`reviewer`，也可能与其他 subagent 同时运行。目前用户只能从工具输出、后台通知或 FleetView 判断成员状态，缺少一个持续、紧凑、跨 TUI 与 pi-web 的团队视图。

本功能提供统一的团队状态快照：Pi TUI 使用右侧非模态 overlay；未修改的 stock pi-web 使用现有 Extension Status/Widget 协议展示同一份跨进程状态。

已实测 stock pi-web 会加载通过 Git package 安装的本项目扩展：对运行中的 pi-web 会话调用 `get_commands` 可见 `/team`、`/team-models`、`/team-fallback`、`/team-doctor`，且 `sourceInfo` 指向 `pi-multi-agent-team` Git package。

## 2. 目标

1. 列出当前会话的 Leader、Team 角色和其他活跃 subagent。
2. 每名成员显示：
   - 角色图标和身份颜色/符号；
   - 状态；
   - 简短任务标题；
   - 最近 1–2 行 assistant 输出，缺失时显示当前工具或活动。
3. Leader 始终置顶；其他成员按活跃优先、开始时间排序。
4. 成功或失败的终态卡片保留 30 秒后移除。
5. TUI 以右侧卡片 overlay 显示；窄终端降级为单行状态摘要。
6. stock pi-web 不改源码：始终显示单行 Extension Status，详细成员列表通过 Extension Widget 展开。
7. TUI 与 pi-web 可以观察同一已持久化会话中由任一宿主进程启动的团队任务。
8. 可视化故障不得阻塞 Team 命令、主 Agent 或子 Agent 执行。

## 3. 非目标

- 不修改或 fork `pi-subagents`、`pi-mono`、`pi-web`。
- 不在首版提供 steer、stop、resume、打开子会话等控制操作。
- 不把 Web 详细列表放入右侧栏；stock pi-web 没有第三方 React 面板插槽。
- 不承诺在拥有任务的父 Pi 进程退出后继续追踪仍存活的 detached child。
- 不把快照当作审计日志、可靠消息队列或安全边界。
- 不保存 thinking、完整 prompt、完整 result、工具参数或凭据。

## 4. 总体架构

```text
本进程 subagent / Agent 工具事件
              │
              ├── foreground: tool events 为成员单一事实源
              │
              └── async: tool result 取得 runId/asyncId
                          │
                          ▼
                 asyncSnapshot 按 node.id 关联
              │
              ▼
      Team Runtime Reducer
              │
              ▼
  TeamRuntimeShardV1（每 writer 独立）
              │
       原子写入共享目录
              │
       ┌──────┴────────┐
       ▼               ▼
 TUI overlay      pi-web 中的 Team 扩展实例
                         │
                 setStatus + setWidget
                         │
                         ▼
                  stock ExtensionWidgets
```

`pi.events` 只在当前进程内有效，因此跨 TUI/pi-web 同步以用户级文件 shard 为边界。每个拥有本地团队任务的父 Pi 进程只写自己的 shard；观察型进程只读并聚合。

## 5. 状态模型

### 5.1 成员类型

```ts
type TeamRole =
  | "leader"
  | "deep-researcher"
  | "challenger"
  | "executor"
  | "reviewer"
  | "other";

type TeamMemberState =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "stale";

interface TeamMemberStatusV1 {
  key: string;             // 不透明成员 key，不暴露 run/tool/session id
  role: TeamRole;
  agent?: string;          // 最多 96 字符
  title: string;           // 最多 160 字符
  preview: string[];       // 最多 2 行，每行最多 160 字符
  state: TeamMemberState;
  startedAt?: number;
  updatedAt: number;
  terminalAt?: number;
}
```

### 5.2 Writer shard

```ts
interface TeamRuntimeShardV1 {
  kind: "pi-multi-agent-team.runtime-shard";
  version: 1;
  sessionId: string;
  sessionFile?: string;
  writerId: string;
  writerPid: number;
  heartbeatAt: number;
  activatedAt: number;
  members: TeamMemberStatusV1[];
}
```

约束：

- 每个 shard 最多 16 名成员。
- 单个序列化 shard 最多 32 KiB。
- 时间均为非负 epoch milliseconds。
- 消费者忽略未知字段；未知 `version` 或 `kind` 的文件不参与聚合。

### 5.3 Session namespace

使用 `ctx.sessionManager.getSessionId()` 作为跨宿主稳定身份：该值来自 session header，在 ephemeral → persisted 过程中保持不变；pi-web 打开同一 session file 时取得同一 ID。

目录名不是原始 ID，而是：

```text
sha256("pi-multi-agent-team:v1:" + sessionId)
```

用户级绝对基目录通过 Pi 的 `getAgentDir()` 获得，以兼容 `PI_CODING_AGENT_DIR`：

```text
<getAgentDir()>/team-status/v1/<session-hash>/<writer-id>.json
```

shard 内保留原始 `sessionId` 和可选 `sessionFile`，读入时必须再次核对，避免哈希目录被错误复用。

未持久化会话可以在当前 TUI 进程内显示，但 pi-web 无法打开该会话，因此不承诺此阶段的跨进程投影。

## 6. Writer、Observer 与成员身份

### 6.1 Writer 判定

扩展实例初始是 observer。满足任一条件后成为 writer：

1. 当前进程成功执行 `/team`；
2. 当前进程观察到由自己拥有的 `subagent` 或 pi-web 内建 `Agent` 工具进入 execution start。

仅打开或浏览会话的 pi-web 实例保持 observer，不写 leader 或空 shard。

Writer 在拥有 active 成员时每 2 秒更新 `heartbeatAt`；只有 Leader 且无活跃 child 时最多每 5 秒更新。Observer 每 1 秒读取当前 session namespace 下的 shard。

### 6.2 唯一 writer 规则

- 子 Agent 不加载 Team 扩展；现有角色定义继续保持 `load_extensions` 关闭。
- 父进程 adapter 是其派生子成员的唯一 writer。
- 所有子成员写入父会话 namespace，而不是子会话 namespace。
- 同一父会话允许 TUI writer 与 pi-web writer 并存，因为它们代表不同进程实际拥有的任务。

### 6.3 成员 key

内部身份为：

```text
sha256(writerId + parentToolCallId + childIndex)
```

- 同一 writer 的一个子任务在所有更新中保持稳定。
- 不尝试将该 key 与 `fleetStatus.entries[].key` 关联；Fleet key 是不透明 reconciliation key。
- 不同 writer 的任务即使角色和标题相同也视为不同成员。
- Leader 聚合时按 `role="leader"` 去重，保留 `updatedAt` 最新的记录。

## 7. 数据来源与关联

### 7.1 Foreground `subagent`

Foreground 成员只使用父进程的工具事件，不与 Fleet DTO 做逐条 join：

- `tool_execution_start`：从 `agent`、`task`、workflow child key/index 建立成员；
- `tool_execution_update`：从 partial result 更新状态、当前工具、tokens 和 preview；
- `tool_execution_end`：写入 terminal 状态和时间。

任务标题从调用参数派生：优先取任务包 `## 目标` 后首个非空句，否则取首个非空句。

### 7.2 Async `subagent` / workflow

- 启动工具的 partial/final result 提供 `runId`/`asyncId` 和 async artifact identity。
- 以 `runId`/`asyncId` 关联公开 RPC `status` 返回的 `asyncSnapshot.runs[].id`。
- `asyncSnapshot` 提供状态、树形 step、`currentTool`、turn/tool count 和时间。
- 调用时的 workflow key/child index 与 task packet 仍是标题和 Team 角色映射来源。
- `fleetStatus` 只用于 active 总数、capacity 和 omitted 提示，不作为成员身份、标题或 preview 的 join 数据源；当前 v1 的 `goal` 不能假设存在。
- artifact 或子会话尾部仅可作为 preview 的可选补充，不参与成员身份或 active 判定。

### 7.3 pi-web 内建 `Agent`

在 `ctx.mode === "rpc"` 的父扩展实例中观察工具名 `Agent`：

- start：从 profile/description/task 建立成员；
- update：从 `pi-web-subagent` partial details 更新状态和 preview；
- end：foreground Agent 写 terminal 状态；background Agent 保留 `sessionId → member key` 关联；
- `message_end` 中的 `pi-web:subagent-notification` custom message 提供 background Agent 的终态通知，按 `details.sessionId` 更新原成员。

若当前 pi-web 版本的 partial details 或 notification 缺少某字段，adapter 退化为标题 + 当前工具/状态，不解析 pi-web 内部 HTTP API。

### 7.4 Team 与其他 Agent 分类

精确名称映射：

- `deep-researcher` → researcher
- `challenger` → challenger
- `executor` → executor
- `reviewer` → reviewer
- 主会话 → leader
- 其他 profile/agent → other

同角色可以有多个并发实例，每个实例保留独立卡片。

## 8. 标题、Preview 与隐私

### 8.1 展示提取

- `title`：任务包 `## 目标` 后首句，或 task 首句；压缩空白后截断到 160 字符。
- `preview`：assistant 文本最后两个非空显示行；单行截断到 160 字符。
- 没有 assistant 文本时，显示当前工具的安全摘要，例如“正在读取 AppShell.tsx”；不显示完整工具参数。

### 8.2 净化

写盘前必须：

1. 移除 ANSI、OSC、控制字符、双向文本控制符和无效 surrogate；
2. 折叠异常空白；
3. 对常见 token、API key、Bearer credential、私钥头做 best-effort 脱敏；
4. 应用字段与总字节上限。

脱敏只是减少噪音和意外暴露，**不是安全保证**。assistant 输出本身可能包含秘密，160 字符限制也不能证明安全。

### 8.3 文件权限

- Unix：目录尽力使用 `0o700`，文件使用 `0o600`。
- Windows：依赖用户配置目录的继承 ACL；这是已接受的残余风险。
- 不通过网络暴露 shard，不启动本地 HTTP 服务。

## 9. 存储、心跳与垃圾回收

### 9.1 原子写

所有 shard 写入必须：

1. 在目标目录写唯一 `.tmp` 文件；
2. flush/close；
3. 同目录 rename 到 `<writerId>.json`；
4. Windows rename 覆盖冲突时使用安全的替换策略，但不得让读者看到半个 JSON。

读取损坏或半写文件时忽略该次结果并进行限频诊断，不清空上一份内存快照。

### 9.2 Liveness

本功能使用 **Team writer 自己的 heartbeat**，不把 pi-subagents `lastUpdate` 当心跳：

- `now - heartbeatAt <= 15s`：live；
- `15s < age <= 60s`：stale，卡片显示警告；
- `age > 60s`：忽略该 shard。

Writer PID 只用于诊断，不作为 Windows 上的唯一存活判据。

30 秒窗口只用于已知 terminal 成员；与 heartbeat/stale 判定无关。

### 9.3 GC

在 `session_start` 和 Team 面板启用时，对用户级 `team-status/v1` 基目录做有界清理：

- 删除超过 24 小时的 shard；
- 删除超过安全临时窗口的 `.tmp`；
- 单次最多检查固定数量文件，避免启动时无界扫描。

## 10. TUI 设计

### 10.1 Overlay

仅当 `ctx.mode === "tui"`：

- 通过 `ctx.ui.custom(..., { overlay: true })` 创建；
- anchor 为 `top-right`，宽度约 46 列，设置合理 margin/maxHeight；
- `onHandle` 获取 handle 后立即 `unfocus()`，不得抢占编辑器输入；
- 保存组件或工厂中的 `tui.requestRender()`，状态变化时请求重绘；
- `overlayOptions.visible` 在终端宽度低于默认 110 列时隐藏；该阈值作为常量并覆盖边界测试；
- 窄终端继续通过 `ctx.ui.setStatus()` 显示单行摘要，不注册第二份详情 widget，避免双显示。

### 10.2 生命周期状态机

```text
hidden --show/auto+data--> mounting --> visible
visible --hide-----------> disposed
visible --shutdown-------> disposed
visible --narrow---------> responsive-hidden
responsive-hidden --wide-> visible
```

- Overlay factory 必须保存 `done` 回调；hide/shutdown 调用 `done(null)`，让 `ctx.ui.custom()` Promise 正常 resolve 并触发组件 `dispose()`。`OverlayHandle` 只用于 `unfocus()`/可见性控制；直接 `handle.hide()` 不会解决宿主 Promise，因此不能作为正常关闭路径。
- Promise 采用受控 fire-and-forget；捕获 rejection，并在 `finally` 丢弃 handle、done、component 引用，不能产生未处理 Promise。
- `session_shutdown` 清 timer、轮询器、overlay 和组件引用。
- `/reload` 后由新的 `session_start` 重建，旧 context 不得复用。

### 10.3 命令

`/team-panel show|hide|auto`：

- TUI：控制 overlay；
- RPC/pi-web：控制 `setStatus`/`setWidget` 投影是否启用，并用通知说明 Web 详细列表位于 Extension Widget；
- 无参数返回当前模式。

## 11. stock pi-web 设计

在 `ctx.mode === "rpc"`：

1. `session_start` 启动 1 秒轮询，只读取当前 session namespace；
2. `setStatus("team-status", summary)` 显示常驻单行摘要；
3. `setWidget("team-status", lines, { placement: "aboveEditor" })` 投影详细成员列表；
4. `session_shutdown` 清轮询并删除 status/widget。

单行摘要必须包含有效信息，例如：

```text
◆ Team · 1 leader · 3 running · 1 failed
```

stock `ExtensionWidgets` 行为是产品契约的一部分：

- 详细列表为 2–3 行时可能默认展开；
- 超过 3 行时通常只显示 trigger，需要用户点击；
- 扩展不控制或伪造默认展开状态；
- 不承诺右侧栏或原生卡片 DOM。

Web 身份主要依赖符号和文本标签。可选 ANSI SGR 颜色只能作为增强；即使宿主剥离颜色，内容仍须可辨认。

## 12. 视觉语言

角色默认标识：

| 角色 | 图标 | TUI 语义色 | 无颜色降级 |
|---|---|---|---|
| Leader | `◆` | accent | `Leader` 标签 |
| Researcher | `⌕` | link/type | `Researcher` 标签 |
| Challenger | `!` | warning | `Challenger` 标签 |
| Executor | `›` | success | `Executor` 标签 |
| Reviewer | `✓` | accent/type | `Reviewer` 标签 |
| Other | `•` | muted | agent/profile 名 |

图标必须配合文字，不能只靠颜色表达身份或状态。

TUI 卡片示意：

```text
◆ Leader · active
  Team 团队可视化
  正在协调设计与任务拆分

› Executor · running · 38s
  实现状态聚合器
  Running reducer tests...
```

## 13. 模块边界

建议文件：

```text
extensions/
  index.ts
  team-status/
    types.ts
    sanitize.ts
    reducer.ts
    store.ts
    pi-subagents-adapter.ts
    pi-web-agent-adapter.ts
    controller.ts
    tui-overlay.ts
    web-widget.ts
```

职责：

- `types.ts`：版本化 DTO 与配置常量。
- `sanitize.ts`：显示文本净化、脱敏、标题/preview 提取。
- `reducer.ts`：纯状态归并、排序、terminal retention、leader 去重。
- `store.ts`：session namespace、shard 原子读写、聚合、GC。
- `pi-subagents-adapter.ts`：`subagent` 工具事件与 RPC asyncSnapshot。
- `pi-web-agent-adapter.ts`：内建 `Agent` 工具事件。
- `controller.ts`：session 生命周期、writer/observer、timer、投影调度。
- `tui-overlay.ts`：TUI 组件和 overlay 状态机。
- `web-widget.ts`：status/widget 文本渲染。
- `index.ts`：组合原有 Team 命令与 visualization controller，不承载具体实现。

## 14. 错误处理

- 任一 adapter、文件或 UI 错误均记录限频诊断并退化，不抛出到 Team 主流程。
- RPC capability 缺失时 foreground 仍使用工具事件；async 只显示可证明的状态，不猜测。
- preview 暂时不可读时保留上一条并标 stale，不清空整张卡片。
- 版本未知、sessionId 不匹配、路径越界、超限 JSON 一律拒绝参与聚合。
- 观察型 pi-web wrapper 尚未启动时没有 Widget；打开对应会话并绑定扩展后从 shard 恢复。

## 15. 测试策略

### 15.1 纯单元测试

使用 Node 内建 test runner；clock、filesystem、hash 和 PID 信息通过参数注入：

- session namespace 稳定性和会话隔离；
- 双 writer 聚合、Leader 去重、同角色多实例；
- `writerId + toolCallId + childIndex` key 稳定性；
- active heartbeat、15 秒 stale、60 秒忽略；
- terminal 30 秒保留；
- 16 成员、32 KiB 和字段长度上限；
- ANSI/控制字符/双向字符净化和常见凭据脱敏；
- 损坏 JSON、未知版本、sessionId 不匹配；
- 原子写、Windows 替换失败恢复和有界 GC；
- foreground 工具事件和 asyncSnapshot 关联；
- Web 2–3 行可能展开、>3 行 trigger 的展示口径；
- TUI 宽度阈值和每行不超宽。

### 15.2 生命周期集成测试

使用 fake `ExtensionAPI`/`ExtensionContext`：

- factory 阶段不启动 timer；
- `session_start` 后启动 writer/observer；
- `session_shutdown` 后没有 timer、widget、status、overlay 或 stale context 引用；
- `/team-panel` show/hide/auto 状态机；
- RPC 模式绝不调用 TUI overlay；TUI 模式绝不创建 Web 详情 widget。

### 15.3 手工 E2E

1. 通过 Git package 安装并启动 stock pi-web。
2. TUI `/team` 启动一个 Team workflow。
3. 验证 TUI overlay 出现 Leader 和成员，title/preview 更新。
4. stock pi-web 打开同一已持久化会话。
5. 验证 `get_commands` 能看到 Team 扩展。
6. 验证单行 status 实时更新，点击 `team-status` 展开详细列表。
7. 验证完成/失败卡片保留约 30 秒后消失。
8. 验证 `/reload`、会话切换和关闭 pi-web 后无残留 timer 或错误通知。

## 16. 安装与兼容

正式分发继续使用 Git package：

```text
git:ssh://git@ssh.github.com:443/CloudFan-cyf/pi-multi-agent-team.git
```

本功能只依赖现有 Pi Extension API 和已安装的 `pi-subagents` 公共 RPC。缺少 RPC capability 时自动降级；不要求用户替换 Pi、pi-subagents 或 pi-web。

兼容基线以实现时已安装版本为准：

- `@earendil-works/pi-coding-agent` 0.84.x；
- `pi-subagents` 0.56.x；
- stock `@agegr/pi-web` 0.8.x。

## 17. 验收标准

- 只修改 `pi-multi-agent-team`。
- TUI 宽终端显示非抢焦点右侧 overlay；窄终端显示单行摘要。
- stock pi-web 无源码修改即可显示常驻摘要和可展开详细列表。
- Leader 固定置顶；Team 角色有明确图标/颜色或无颜色标签；其他 Agent 使用中性样式。
- 每名成员有标题、状态和最多两行 preview；不可得时有诚实降级。
- 双 writer 不覆盖，Leader 不重复，同角色并发任务不错误合并。
- 30 秒 terminal retention、heartbeat/stale/ignore 语义通过测试。
- 不使用 Fleet opaque key 做 tool event join；async 使用 runId/asyncSnapshot node.id。
- 快照满足净化、上限、原子写、权限和 session 隔离要求。
- `session_shutdown` 后没有 timer、widget、status、overlay 或临时文件泄漏。
- 自动测试通过，并完成 TUI → stock pi-web 跨进程手工 E2E。

## 18. 已知限制与接受的残余风险

1. stock pi-web 的详细列表可能折叠，需要用户点击；不会显示为右侧栏。
2. 父 Pi 进程退出后仍运行的 detached child 不在 v1 持续追踪范围；旧 shard 会先 stale 后消失。
3. preview 持久化在本地用户目录；best-effort 脱敏不是安全保证，Windows 文件权限依赖继承 ACL。
4. Web 颜色是渐进增强，符号和文字才是可靠身份标识。
5. overlay 是实验性 API；通过严格生命周期清理降低风险，但未来 Pi API 变化可能需要适配。
6. pi-web 只有在对应会话建立 RPC wrapper、绑定扩展后才会投影 Widget。
7. pi-web 内建 `Agent` 的 partial details 不是跨项目标准；adapter 必须防御字段缺失并保持降级。

## 19. 设计挑战裁决记录

### 第 1 轮

采纳：验证 stock pi-web 扩展加载、固定 session namespace、区分 Team heartbeat 与 pi-subagents lastUpdate、定义父 adapter 唯一 writer、明确 Web 折叠口径、补 overlay 生命周期、文件权限与轮询清理。

### 第 2 轮

原 challenger 的 retained resume 在当前 Windows npm shim 环境报 `spawn pi ENOENT`，因此使用完整任务包启动同角色 fresh fallback 完成最终复审。

采纳：

- foreground 改为 tool event 单源；
- async 通过 tool result runId/asyncId 关联 asyncSnapshot node.id；
- Fleet opaque key 仅作汇总，不做逐成员 join；
- 基目录固定为 `getAgentDir()` 下的用户级绝对路径；
- 明确 writer/observer 晋升规则；
- 补充 2–3 行 Web 自动展开口径、原子写、stale 显示、颜色降级和脱敏非安全边界。

第 2 轮后不再继续挑战；上述已知限制由领导者知情接受。
