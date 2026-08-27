/**
 * Team 团队可视化 — reducer 单测：本地状态、跨 shard 聚合排序、liveness 与 terminal 保留。
 *
 * 固定 epoch NOW（1_800_000_000_000，与 fixtures 一致）。涉及排序断言的成员
 * 均显式给定确定性 startedAt，使「最新活跃优先」的期望顺序有确定含义
 * （controller ruling：fixture members used in ordering assertions must set
 * deterministic startedAt values）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeMemberKey } from "../../extensions/team-status/sanitize.ts";
import { TEAM_STATUS_KIND } from "../../extensions/team-status/types.ts";
import {
  activateLeader,
  aggregateRuntimeShards,
  createRuntimeState,
  removeMember,
  toRuntimeShard,
  upsertMember,
} from "../../extensions/team-status/reducer.ts";
import { completed, executor, leader, NOW, SESSION_ID, shard } from "./fixtures.mjs";

test("aggregate pins the newest leader and preserves same-role concurrent tasks", () => {
  const aggregate = aggregateRuntimeShards(
    [
      shard({
        writerId: "a",
        heartbeatAt: NOW,
        members: [
          { ...leader("a", NOW - 10), startedAt: NOW - 10 },
          { ...executor("a-1", NOW - 20), startedAt: NOW - 20 },
        ],
      }),
      shard({
        writerId: "b",
        heartbeatAt: NOW,
        members: [
          { ...leader("b", NOW), startedAt: NOW },
          { ...executor("b-1", NOW - 5), startedAt: NOW - 5 },
        ],
      }),
    ],
    SESSION_ID,
    NOW,
  );
  assert.deepEqual(aggregate.members.map((member) => member.key), ["leader-b", "b-1", "a-1"]);
  assert.equal(aggregate.liveShardCount, 2);
  assert.equal(aggregate.staleShardCount, 0);
});

test("aggregate marks 15-60 second shards stale and ignores older shards", () => {
  const aggregate = aggregateRuntimeShards(
    [
      shard({ writerId: "stale", heartbeatAt: NOW - 20_000, members: [executor("stale-child", NOW - 20_000)] }),
      shard({ writerId: "dead", heartbeatAt: NOW - 61_000, members: [executor("dead-child", NOW - 61_000)] }),
    ],
    SESSION_ID,
    NOW,
  );
  assert.equal(aggregate.members[0].key, "stale-child");
  assert.equal(aggregate.members[0].state, "stale");
  assert.equal(aggregate.members.some((member) => member.key === "dead-child"), false);
  assert.equal(aggregate.liveShardCount, 0);
  assert.equal(aggregate.staleShardCount, 1);
});

test("terminal members remain for 30 seconds only", () => {
  const recent = completed("recent", NOW - 29_999);
  const expired = completed("expired", NOW - 30_001);
  const aggregate = aggregateRuntimeShards([shard({ heartbeatAt: NOW, members: [recent, expired] })], SESSION_ID, NOW);
  assert.deepEqual(aggregate.members.map((member) => member.key), ["recent"]);
});

test("aggregate rejects other sessions and ignores unknown kind or version", () => {
  const foreign = shard({ writerId: "foreign", sessionId: "other-session", members: [executor("foreign-child", NOW)] });
  const wrongKind = { ...shard(), kind: "something-else", members: [executor("wrong-kind", NOW)] };
  const wrongVersion = { ...shard(), version: 2, members: [executor("wrong-version", NOW)] };
  const aggregate = aggregateRuntimeShards([foreign, wrongKind, wrongVersion], SESSION_ID, NOW);
  assert.equal(aggregate.sessionId, SESSION_ID);
  assert.deepEqual(aggregate.members, []);
  assert.equal(aggregate.liveShardCount, 0);
  assert.equal(aggregate.staleShardCount, 0);
});

test("active members sort before terminal members regardless of start time", () => {
  const aggregate = aggregateRuntimeShards(
    [
      shard({
        heartbeatAt: NOW,
        members: [
          { ...completed("done-later", NOW - 1), startedAt: NOW - 1 },
          { ...executor("still-running", NOW - 100), startedAt: NOW - 100 },
        ],
      }),
    ],
    SESSION_ID,
    NOW,
  );
  assert.deepEqual(aggregate.members.map((member) => member.key), ["still-running", "done-later"]);
});

test("members sharing a start time break ties by newest update then key", () => {
  const aggregate = aggregateRuntimeShards(
    [
      shard({
        heartbeatAt: NOW,
        members: [
          { ...executor("tie-older", NOW - 60), startedAt: NOW - 100 },
          { ...executor("tie-newer", NOW - 50), startedAt: NOW - 100 },
        ],
      }),
    ],
    SESSION_ID,
    NOW,
  );
  assert.deepEqual(aggregate.members.map((member) => member.key), ["tie-newer", "tie-older"]);
});

test("aggregate caps at 16 members and reports omittedMembers", () => {
  const members = Array.from({ length: 20 }, (_, i) => ({
    ...executor(`cap-${i}`, NOW - i * 1_000),
    startedAt: NOW - i * 1_000,
  }));
  const aggregate = aggregateRuntimeShards([shard({ heartbeatAt: NOW, members })], SESSION_ID, NOW);
  assert.equal(aggregate.members.length, 16);
  assert.equal(aggregate.members[0].key, "cap-0");
  assert.equal(aggregate.omittedMembers, 4);
});

test("local state: create, activate leader, upsert, remove, and serialize to a shard", () => {
  const state = createRuntimeState({
    sessionId: SESSION_ID,
    sessionFile: "session.json",
    writerId: "w1",
    writerPid: 42,
    now: NOW,
  });
  assert.equal(state.members.size, 0);

  activateLeader(state, { title: "Lead", agent: "leader", now: NOW });
  assert.equal(state.members.size, 1);
  assert.equal(state.members.get(makeMemberKey("w1", "leader", 0))?.role, "leader");

  upsertMember(state, { ...executor("child-1", NOW), startedAt: NOW });
  upsertMember(state, { ...executor("child-1", NOW + 1), startedAt: NOW, title: "Updated" });
  upsertMember(state, { ...executor("child-1", NOW), startedAt: NOW, title: "Older" });
  assert.equal(state.members.get("child-1")?.title, "Updated");

  removeMember(state, "child-1");
  assert.equal(state.members.has("child-1"), false);

  const runtimeShard = toRuntimeShard(state, NOW + 1_000);
  assert.equal(runtimeShard.kind, TEAM_STATUS_KIND);
  assert.equal(runtimeShard.sessionId, SESSION_ID);
  assert.equal(runtimeShard.writerId, "w1");
  assert.equal(runtimeShard.heartbeatAt, NOW + 1_000);
  assert.equal(state.heartbeatAt, NOW + 1_000);
  assert.deepEqual(runtimeShard.members.map((member) => member.key), [makeMemberKey("w1", "leader", 0)]);
});
