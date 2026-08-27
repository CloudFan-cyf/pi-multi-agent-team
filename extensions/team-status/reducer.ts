/**
 * Team 团队可视化 — 本地成员状态归并与跨 shard 聚合（Task 2）。
 *
 * 纯内存、无 I/O：本地写入方维护自己的 TeamRuntimeState，周期序列化为
 * TeamRuntimeShardV1；观察方把各 writer 的 shard 聚合为 TeamAggregateV1。
 *
 * 聚合语义（规格 §2.3、§6.3、§9.2）：
 * - 仅接受同 session、同 kind/version 的 shard；
 * - shard 心跳 age ≤ 15s 视为 live；15s < age ≤ 60s 视为 stale（成员克隆为
 *   state:"stale"）；age > 60s 忽略整个 shard；
 * - Leader 按 role="leader" 去重，保留 updatedAt 最新的一条并始终置顶；
 * - 其他成员活跃（非 terminal）优先，再按 startedAt 降序（最新开始在前）；
 *   同 startedAt 按 updatedAt 降序，再按 key 字典序，保证确定性；
 * - terminal 成员（completed/failed/stopped）从 terminalAt 起保留 30s 后移除；
 * - 结果最多 16 名成员（MAX_MEMBERS），超出部分计入 omittedMembers。
 */
import {
  IGNORE_AFTER_MS,
  MAX_MEMBERS,
  STALE_AFTER_MS,
  TEAM_STATUS_KIND,
  TEAM_STATUS_VERSION,
  TERMINAL_RETENTION_MS,
  type TeamAggregateV1,
  type TeamMemberState,
  type TeamMemberStatusV1,
  type TeamRuntimeShardV1,
} from "./types.ts";
import { makeMemberKey } from "./sanitize.ts";

export interface TeamRuntimeState {
  sessionId: string;
  sessionFile?: string;
  writerId: string;
  writerPid: number;
  activatedAt: number;
  heartbeatAt: number;
  members: Map<string, TeamMemberStatusV1>;
}

/** createRuntimeState 输入：本地 writer 的静态身份与激活时刻。 */
export interface RuntimeStateInput {
  sessionId: string;
  sessionFile?: string;
  writerId: string;
  writerPid: number;
  now: number;
}

/** activateLeader 输入：Leader（主会话）的标题、agent 名与激活时刻。 */
export interface LeaderActivationInput {
  title: string;
  agent?: string;
  now: number;
}

/**
 * Leader 的稳定合成 toolCallId：主会话没有真实工具调用，但成员 key 仍需
 * 确定性（同 writer 的所有更新保持一致）且不暴露 session/writer id。
 */
const LEADER_TOOL_CALL_ID = "leader";
const LEADER_INDEX = 0;

const TERMINAL_STATES: ReadonlySet<TeamMemberState> = new Set(["completed", "failed", "stopped"]);

function isTerminal(member: TeamMemberStatusV1): boolean {
  return TERMINAL_STATES.has(member.state);
}

export function createRuntimeState(input: RuntimeStateInput): TeamRuntimeState {
  return {
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    writerId: input.writerId,
    writerPid: input.writerPid,
    activatedAt: input.now,
    heartbeatAt: input.now,
    members: new Map(),
  };
}

export function activateLeader(state: TeamRuntimeState, input: LeaderActivationInput): void {
  const member: TeamMemberStatusV1 = {
    key: makeMemberKey(state.writerId, LEADER_TOOL_CALL_ID, LEADER_INDEX),
    role: "leader",
    agent: input.agent,
    title: input.title,
    preview: [],
    state: "running",
    startedAt: input.now,
    updatedAt: input.now,
  };
  state.members.set(member.key, member);
}

export function upsertMember(state: TeamRuntimeState, member: TeamMemberStatusV1): void {
  const current = state.members.get(member.key);
  if (!current || member.updatedAt >= current.updatedAt) state.members.set(member.key, member);
}

export function removeMember(state: TeamRuntimeState, key: string): void {
  state.members.delete(key);
}

/** 序列化本地状态为 shard DTO；一次写盘同时视为一次心跳（更新 state.heartbeatAt）。 */
export function toRuntimeShard(state: TeamRuntimeState, now: number): TeamRuntimeShardV1 {
  state.heartbeatAt = now;
  return {
    kind: TEAM_STATUS_KIND,
    version: TEAM_STATUS_VERSION,
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    writerId: state.writerId,
    writerPid: state.writerPid,
    heartbeatAt: now,
    activatedAt: state.activatedAt,
    members: [...state.members.values()],
  };
}

export function aggregateRuntimeShards(
  shards: TeamRuntimeShardV1[],
  sessionId: string,
  now: number,
): TeamAggregateV1 {
  let liveShardCount = 0;
  let staleShardCount = 0;
  const members: TeamMemberStatusV1[] = [];

  for (const shard of shards) {
    if (shard.kind !== TEAM_STATUS_KIND || shard.version !== TEAM_STATUS_VERSION) continue;
    if (shard.sessionId !== sessionId) continue;
    const age = now - shard.heartbeatAt;
    if (age <= STALE_AFTER_MS) {
      liveShardCount += 1;
      for (const member of shard.members) {
        if (isTerminal(member) && isTerminalExpired(member, now)) continue;
        members.push(member);
      }
    } else if (age <= IGNORE_AFTER_MS) {
      staleShardCount += 1;
      for (const member of shard.members) {
        if (isTerminal(member) && isTerminalExpired(member, now)) continue;
        members.push({ ...member, state: "stale" });
      }
    }
    // age > IGNORE_AFTER_MS：忽略整个 shard。
  }

  // Leader 去重：保留 updatedAt 最新的一条；同 updatedAt 取 key 字典序小者，保证确定性。
  let leader: TeamMemberStatusV1 | undefined;
  for (const member of members) {
    if (member.role !== "leader") continue;
    if (
      !leader ||
      member.updatedAt > leader.updatedAt ||
      (member.updatedAt === leader.updatedAt && member.key < leader.key)
    ) {
      leader = member;
    }
  }
  const keptMembers = members.filter((member) => member.role !== "leader");
  if (leader) keptMembers.push(leader);

  keptMembers.sort(compareMembers);

  const omittedMembers = keptMembers.length > MAX_MEMBERS ? keptMembers.length - MAX_MEMBERS : 0;
  return {
    sessionId,
    generatedAt: now,
    members: keptMembers.slice(0, MAX_MEMBERS),
    liveShardCount,
    staleShardCount,
    omittedMembers,
  };
}

/** terminal 成员在 terminalAt 之后保留 30s；无 terminalAt 时无法判龄，不提前移除。 */
function isTerminalExpired(member: TeamMemberStatusV1, now: number): boolean {
  if (typeof member.terminalAt !== "number") return false;
  return now - member.terminalAt > TERMINAL_RETENTION_MS;
}

/**
 * 排序：Leader 置顶 → 活跃优先于 terminal → startedAt 降序（缺失视为最早）→
 * updatedAt 降序 → key 字典序。
 */
function compareMembers(a: TeamMemberStatusV1, b: TeamMemberStatusV1): number {
  const aIsLeader = a.role === "leader" ? 1 : 0;
  const bIsLeader = b.role === "leader" ? 1 : 0;
  if (aIsLeader !== bIsLeader) return bIsLeader - aIsLeader;
  const aTerminal = isTerminal(a) ? 1 : 0;
  const bTerminal = isTerminal(b) ? 1 : 0;
  if (aTerminal !== bTerminal) return aTerminal - bTerminal;
  const aStart = a.startedAt ?? Number.NEGATIVE_INFINITY;
  const bStart = b.startedAt ?? Number.NEGATIVE_INFINITY;
  if (aStart !== bStart) return bStart - aStart;
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
