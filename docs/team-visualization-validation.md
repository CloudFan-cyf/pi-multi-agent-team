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
