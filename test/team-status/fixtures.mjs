/**
 * Team 团队可视化 — 共享测试夹具（确定性 epoch，保证 liveness/retention 窗口稳定）。
 *
 * 供 team-status 各单测复用；生产代码不 import 本模块。
 * NOW 固定为 1_800_000_000_000，避免测试时间漂移。
 */
import {
  TEAM_STATUS_KIND,
  TEAM_STATUS_VERSION,
  type TeamMemberStatusV1,
  type TeamRuntimeShardV1,
} from "../../extensions/team-status/types.ts";

export const NOW = 1_800_000_000_000;
export const SESSION_ID = "fixture-session";

export interface MemberOverrides extends Partial<TeamMemberStatusV1> {}

/** 基础成员工厂：默认 running executor，可用 overrides 覆盖任意字段。 */
export function member(overrides: MemberOverrides = {}): TeamMemberStatusV1 {
  return {
    key: "fixture-member",
    role: "executor",
    title: "Fixture task",
    preview: [],
    state: "running",
    updatedAt: NOW,
    ...overrides,
  };
}

/** Leader 成员（key 使用确定性 writer 前缀，避免与 makeMemberKey 耦合）。 */
export function leader(writerId: string, updatedAt = NOW): TeamMemberStatusV1 {
  return member({ key: `leader-${writerId}`, role: "leader", title: "Leader", updatedAt });
}

/** Executor 成员，key 显式传入。 */
export function executor(key: string, updatedAt = NOW): TeamMemberStatusV1 {
  return member({ key, role: "executor", title: "Executor task", updatedAt });
}

/** 已完成成员（带 terminalAt）。 */
export function completed(key: string, updatedAt = NOW): TeamMemberStatusV1 {
  return member({ key, role: "executor", title: "Completed task", state: "completed", updatedAt, terminalAt: updatedAt });
}

/** Shard 工厂：默认活心跳、默认 sessionId。 */
export function shard(overrides: Partial<TeamRuntimeShardV1> = {}): TeamRuntimeShardV1 {
  return {
    kind: TEAM_STATUS_KIND,
    version: TEAM_STATUS_VERSION,
    sessionId: SESSION_ID,
    writerId: "fixture-writer",
    writerPid: 12345,
    heartbeatAt: NOW,
    activatedAt: NOW,
    members: [],
    ...overrides,
  };
}
