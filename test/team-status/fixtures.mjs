/**
 * Team 团队可视化 — 共享测试夹具（确定性 epoch，保证 liveness/retention 窗口稳定）。
 *
 * 供 team-status 各单测复用；生产代码不 import 本模块。
 * NOW 固定为 1_800_000_000_000，避免测试时间漂移。
 * 本文件为纯 ESM（.mjs），不得使用 TS 语法；类型信息以 JSDoc typedef 记录。
 */
import { TEAM_STATUS_KIND, TEAM_STATUS_VERSION } from "../../extensions/team-status/types.ts";

/**
 * @typedef {Partial<import("../../extensions/team-status/types.ts").TeamMemberStatusV1>} MemberOverrides
 * @typedef {import("../../extensions/team-status/types.ts").TeamMemberStatusV1} TeamMemberStatusV1
 * @typedef {import("../../extensions/team-status/types.ts").TeamRuntimeShardV1} TeamRuntimeShardV1
 */

export const NOW = 1_800_000_000_000;
export const SESSION_ID = "fixture-session";

/** 基础成员工厂：默认 running executor，可用 overrides 覆盖任意字段。 */
export function member(overrides = {}) {
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
export function leader(writerId, updatedAt = NOW) {
  return member({ key: `leader-${writerId}`, role: "leader", title: "Leader", updatedAt });
}

/** Executor 成员，key 显式传入。 */
export function executor(key, updatedAt = NOW) {
  return member({ key, role: "executor", title: "Executor task", updatedAt });
}

/** 已完成成员（带 terminalAt）。 */
export function completed(key, updatedAt = NOW) {
  return member({ key, role: "executor", title: "Completed task", state: "completed", updatedAt, terminalAt: updatedAt });
}

/** Shard 工厂：默认活心跳、默认 sessionId。 */
export function shard(overrides = {}) {
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
