/**
 * Team 团队可视化 — 版本化 DTO 与配置常量（Task 1 契约）。
 *
 * 跨进程共享的只读快照边界：所有字段经净化器处理后写盘；
 * 消费者忽略未知字段；未知 version/kind 的文件不参与聚合。
 */

export const TEAM_STATUS_KIND = "pi-multi-agent-team.runtime-shard" as const;
export const TEAM_STATUS_VERSION = 1 as const;
export const MAX_MEMBERS = 16;
export const MAX_SHARD_BYTES = 32 * 1024;
export const MAX_AGENT_LENGTH = 96;
export const MAX_TEXT_LENGTH = 160;
export const TERMINAL_RETENTION_MS = 30_000;
export const STALE_AFTER_MS = 15_000;
export const IGNORE_AFTER_MS = 60_000;
export const ACTIVE_HEARTBEAT_MS = 2_000;
export const IDLE_HEARTBEAT_MS = 5_000;
export const OBSERVER_POLL_MS = 1_000;
export const TUI_MIN_COLUMNS = 110;

export type TeamRole = "leader" | "deep-researcher" | "challenger" | "executor" | "reviewer" | "other";
export type TeamMemberState = "idle" | "starting" | "running" | "completed" | "failed" | "stopped" | "stale";
export type PanelMode = "auto" | "show" | "hide";

export interface TeamMemberStatusV1 {
  key: string;
  role: TeamRole;
  agent?: string;
  title: string;
  preview: string[];
  state: TeamMemberState;
  startedAt?: number;
  updatedAt: number;
  terminalAt?: number;
}

export interface TeamRuntimeShardV1 {
  kind: typeof TEAM_STATUS_KIND;
  version: typeof TEAM_STATUS_VERSION;
  sessionId: string;
  sessionFile?: string;
  writerId: string;
  writerPid: number;
  heartbeatAt: number;
  activatedAt: number;
  members: TeamMemberStatusV1[];
}

export interface TeamAggregateV1 {
  sessionId: string;
  generatedAt: number;
  members: TeamMemberStatusV1[];
  liveShardCount: number;
  staleShardCount: number;
  omittedMembers: number;
}
