/**
 * Team 团队可视化 — 确定性本地 fixture（Task 9）。
 *
 * 在真实用户级 agent 目录中，用生产 `TeamShardStore` + reducer API 写入一个
 * 活的 Leader + Executor shard，并按 ACTIVE_HEARTBEAT_MS 节奏刷新心跳，直到
 * `--duration-ms` 到期；随后在 `finally` 中移除自身 shard（幂等）。收到
 * SIGINT/SIGTERM 时同样清理后退出。用于手工/半自动验证 stock pi-web 与 TUI
 * 对同一持久化会话的跨进程投影，不启动任何 HTTP 服务、不接触认证/凭据文件。
 *
 * 用法（需 Node 的 strip-types 以直接 import .ts 生产代码）：
 *   node --experimental-strip-types scripts/write-team-status-fixture.mjs \
 *     --agent-dir "$HOME/.pi/agent" \
 *     --session-id "01a040fe-5145-759f-a32f-5ad7b9a0c904" \
 *     --duration-ms 60000
 *
 * 退出码：0 = 成功；2 = 参数错误（缺参 / 非正时长）；1 = 运行期错误。
 */
import { TeamShardStore } from "../extensions/team-status/store.ts";
import {
  activateLeader,
  createRuntimeState,
  toRuntimeShard,
  upsertMember,
} from "../extensions/team-status/reducer.ts";
import { makeMemberKey } from "../extensions/team-status/sanitize.ts";
import { ACTIVE_HEARTBEAT_MS } from "../extensions/team-status/types.ts";

/** 本 fixture 的稳定 writerId（真实 writer 使用随机 UUID，不会冲突）。 */
const FIXTURE_WRITER_ID = "fixture";
const DEFAULT_DURATION_MS = 60_000;

/** 成员角色与标题（确定性，便于断言 Leader/Executor 身份）。 */
const FIXTURE_LEADER_TITLE = "Team fixture leader";
const FIXTURE_EXECUTOR_TITLE = "Fixture executor task";
const FIXTURE_EXECUTOR_PREVIEW = ["Running fixture executor..."];

const KNOWN_OPTIONS = new Set(["--agent-dir", "--session-id", "--duration-ms"]);

/**
 * 解析 CLI 参数。返回 `{ ok: true, ... }` 或 `{ ok: false, error }`。
 * 缺参 / 缺值 / 未知参数 / 非正时长 → error（退出码 2）。
 */
function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      return { ok: false, error: `unexpected positional argument: ${arg}` };
    }
    if (!KNOWN_OPTIONS.has(arg)) {
      return { ok: false, error: `unknown option: ${arg}` };
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `missing value for ${arg}` };
    }
    values.set(arg, value);
    i += 1;
  }

  const agentDir = values.get("--agent-dir");
  const sessionId = values.get("--session-id");
  if (!agentDir) return { ok: false, error: "missing required --agent-dir" };
  if (!sessionId) return { ok: false, error: "missing required --session-id" };

  const durationRaw = values.get("--duration-ms") ?? String(DEFAULT_DURATION_MS);
  const durationMs = Number(durationRaw);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, error: `--duration-ms must be a positive number (got ${JSON.stringify(durationRaw)})` };
  }

  return { ok: true, agentDir, sessionId, durationMs };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}`);
    process.exit(2);
  }

  const { agentDir, sessionId, durationMs } = parsed;
  const store = new TeamShardStore({ agentDir });
  const writerId = FIXTURE_WRITER_ID;
  const now = () => Date.now();

  // 用生产 reducer 构造 runtime：Leader + 一个 running Executor。
  const runtime = createRuntimeState({ sessionId, writerId, writerPid: process.pid, now: now() });
  activateLeader(runtime, { title: FIXTURE_LEADER_TITLE, agent: "leader", now: now() });
  upsertMember(runtime, {
    key: makeMemberKey(writerId, "executor", 0),
    role: "executor",
    agent: "executor",
    title: FIXTURE_EXECUTOR_TITLE,
    preview: FIXTURE_EXECUTOR_PREVIEW,
    state: "running",
    startedAt: now(),
    updatedAt: now(),
  });

  // 提前清理 + 幂等标记，信号与 finally 共用。
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await store.remove(sessionId, writerId).catch(() => {});
  };

  const onSignal = (signal) => {
    const code = signal === "SIGINT" ? 130 : 143;
    void cleanup().then(() => process.exit(code));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const startedAt = now();
  try {
    // 首写立即发生；随后按 active heartbeat 节奏刷新，直到时长到期。
    while (true) {
      await store.write(toRuntimeShard(runtime, now()));
      const remaining = durationMs - (now() - startedAt);
      if (remaining <= 0) break;
      await sleep(Math.min(remaining, ACTIVE_HEARTBEAT_MS));
    }
    console.log(
      `fixture: wrote Leader+Executor shard for ${durationMs}ms (session=${sessionId}, agentDir=${agentDir})`,
    );
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
