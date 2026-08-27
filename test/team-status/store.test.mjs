/**
 * Team 团队可视化 — store 单测：session namespace、shard 校验、原子替换、有界 GC。
 *
 * 所有真实文件系统测试都在 mkdtemp 隔离目录内进行，t.after 递归清理；
 * 注入的 file ops 仅用于模拟替换失败（failFirstRenameWith）与断言权限请求
 * （Unix mode requests）。确定性 now/randomUUID 保证原子替换路径可复现。
 *
 * 生产代码暴露的 GC 常量（GC_SHARD_RETENTION_MS / GC_TMP_RETENTION_MS /
 * GC_MAX_SCAN_FILES）作为唯一事实来源，测试以行为断言而非魔法数字对齐。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, readdir, stat, utimes, writeFile, rm } from "node:fs/promises";
import {
  TeamShardStore,
  defaultShardFileOps,
  GC_MAX_SCAN_FILES,
  GC_SHARD_RETENTION_MS,
  GC_TMP_RETENTION_MS,
  parseRuntimeShard,
  sessionNamespace,
} from "../../extensions/team-status/store.ts";
import { TEAM_STATUS_KIND, TEAM_STATUS_VERSION, MAX_SHARD_BYTES } from "../../extensions/team-status/types.ts";
import { NOW, SESSION_ID, member, shard } from "./fixtures.mjs";

/** 首次 rename 抛给定 errno code，之后委托真实 rename —— 模拟 Windows 覆盖冲突。 */
function failFirstRenameWith(code) {
  let failed = false;
  return {
    ...defaultShardFileOps,
    rename: async (from, to) => {
      if (!failed) {
        failed = true;
        const err = new Error(`${code}: simulated replacement failure`);
        err.code = code;
        throw err;
      }
      return defaultShardFileOps.rename(from, to);
    },
  };
}

/** 确定性 UUID 序列，保证原子写生成的 tmp/bak 名稳定。 */
function sequenceUuid() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 每个测试独占的 mkdtemp 目录；t.after 递归删除。 */
async function makeStore(t, overrides = {}) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "team-store-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const store = new TeamShardStore({ agentDir, now: () => NOW, randomUUID: sequenceUuid(), ...overrides });
  return { agentDir, store };
}

test("sessionNamespace is absolute, stable, and does not expose session id", () => {
  const agentDir = path.resolve("fixture-agent-dir");
  const dir = sessionNamespace(agentDir, "session-secret");
  assert.equal(path.isAbsolute(dir), true);
  assert.equal(dir.includes("session-secret"), false);
  assert.equal(dir, sessionNamespace(agentDir, "session-secret"));
  assert.equal(path.basename(dir).length, 64);
});

test("write uses a bounded valid shard and read rejects another session", async (t) => {
  const { store } = await makeStore(t);
  await store.write(shard({ sessionId: "one", writerId: "writer-a" }));
  assert.equal((await store.read("one")).length, 1);
  assert.equal((await store.read("two")).length, 0);
});

test("a failed replacement never exposes partial JSON", async (t) => {
  const { agentDir } = await makeStore(t);
  const failingOps = failFirstRenameWith("EPERM");
  const retryingStore = new TeamShardStore({ agentDir, ops: failingOps, now: () => NOW, randomUUID: sequenceUuid() });
  await retryingStore.write(shard({ writerId: "writer-a", heartbeatAt: NOW }));
  assert.equal((await retryingStore.read(SESSION_ID))[0].heartbeatAt, NOW);
});

test("write requests 0700 dir and 0600 file modes on Unix", async (t) => {
  const { agentDir } = await makeStore(t);
  const calls = { mkdir: null, writeFile: null };
  const ops = {
    ...defaultShardFileOps,
    mkdir: async (dir, opts) => {
      calls.mkdir = { dir, opts };
    },
    writeFile: async (file, data, opts) => {
      calls.writeFile = { file, opts };
    },
    rename: async () => {},
    unlink: async () => {},
  };
  const store = new TeamShardStore({ agentDir, ops, now: () => NOW, randomUUID: sequenceUuid() });
  await store.write(shard({ writerId: "writer-a" }));
  assert.equal(calls.mkdir.opts.recursive, true);
  assert.equal(calls.mkdir.opts.mode, 0o700);
  assert.equal(calls.writeFile.opts.mode, 0o600);
});

test("parseRuntimeShard rejects unknown version or kind or foreign session", () => {
  assert.ok(parseRuntimeShard(JSON.stringify(shard({ writerId: "w" })), SESSION_ID));
  assert.equal(parseRuntimeShard(JSON.stringify({ ...shard(), kind: "other" }), SESSION_ID), undefined);
  assert.equal(parseRuntimeShard(JSON.stringify({ ...shard(), version: 2 }), SESSION_ID), undefined);
  assert.equal(parseRuntimeShard(JSON.stringify({ ...shard(), sessionId: "other-session" }), SESSION_ID), undefined);
});

test("parseRuntimeShard ignores malformed JSON and structurally broken shards", () => {
  assert.equal(parseRuntimeShard("{not json", SESSION_ID), undefined);
  assert.equal(parseRuntimeShard("null", SESSION_ID), undefined);
  assert.equal(parseRuntimeShard("[1, 2]", SESSION_ID), undefined);
  assert.equal(
    parseRuntimeShard(
      JSON.stringify({ kind: TEAM_STATUS_KIND, version: TEAM_STATUS_VERSION, sessionId: SESSION_ID }),
      SESSION_ID,
    ),
    undefined,
  );
});

test("write rejects shards exceeding 32 KiB serialized", async (t) => {
  const { store } = await makeStore(t);
  const big = shard({ writerId: "big", members: [{ ...member(), title: "x".repeat(MAX_SHARD_BYTES) }] });
  await assert.rejects(store.write(big), /32 KiB|MAX_SHARD_BYTES|exceed/i);
  assert.equal((await store.read(SESSION_ID)).length, 0);
});

test("successful and replacement writes leave no .tmp or .bak behind", async (t) => {
  const { agentDir } = await makeStore(t);
  const store = new TeamShardStore({ agentDir, now: () => NOW, randomUUID: sequenceUuid() });
  await store.write(shard({ writerId: "writer-a", heartbeatAt: NOW }));
  const replacing = new TeamShardStore({
    agentDir,
    ops: failFirstRenameWith("EEXIST"),
    now: () => NOW,
    randomUUID: sequenceUuid(),
  });
  await replacing.write(shard({ writerId: "writer-a", heartbeatAt: NOW + 1 }));
  const dir = sessionNamespace(agentDir, SESSION_ID);
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, ["writer-a.json"]);
  assert.equal((await store.read(SESSION_ID))[0].heartbeatAt, NOW + 1);
});

test("remove deletes only the given writer shard and is idempotent", async (t) => {
  const { store } = await makeStore(t);
  await store.write(shard({ writerId: "a" }));
  await store.write(shard({ writerId: "b" }));
  assert.equal((await store.read(SESSION_ID)).length, 2);
  await store.remove(SESSION_ID, "a");
  const shards = await store.read(SESSION_ID);
  assert.equal(shards.length, 1);
  assert.equal(shards[0].writerId, "b");
  await store.remove(SESSION_ID, "a");
  assert.equal((await store.read(SESSION_ID)).length, 1);
});

test("gc removes stale .tmp files and keeps fresh ones", async (t) => {
  const { agentDir, store } = await makeStore(t, { now: () => Date.now() });
  const dir = sessionNamespace(agentDir, SESSION_ID);
  await mkdir(dir, { recursive: true });
  const staleTmp = path.join(dir, ".writer-a.00000000-0000-4000-8000-000000000000.tmp");
  const freshTmp = path.join(dir, ".writer-a.00000000-0000-4000-8000-000000000001.tmp");
  await writeFile(staleTmp, "{}");
  await writeFile(freshTmp, "{}");
  const old = new Date(Date.now() - GC_TMP_RETENTION_MS - 60_000);
  await utimes(staleTmp, old, old);
  await store.gc();
  assert.equal(await exists(staleTmp), false);
  assert.equal(await exists(freshTmp), true);
});

test("gc removes shards older than 24 hours and keeps fresh shards", async (t) => {
  const { agentDir, store } = await makeStore(t, { now: () => Date.now() });
  await store.write(shard({ writerId: "old" }));
  await store.write(shard({ writerId: "fresh" }));
  const dir = sessionNamespace(agentDir, SESSION_ID);
  const oldFile = path.join(dir, "old.json");
  const old = new Date(Date.now() - GC_SHARD_RETENTION_MS - 60_000);
  await utimes(oldFile, old, old);
  await store.gc();
  assert.equal(await exists(oldFile), false);
  assert.equal(await exists(path.join(dir, "fresh.json")), true);
});

test("gc scans at most GC_MAX_SCAN_FILES files per run", async (t) => {
  const { agentDir, store } = await makeStore(t, { now: () => Date.now() });
  const dir = sessionNamespace(agentDir, SESSION_ID);
  await mkdir(dir, { recursive: true });
  const total = GC_MAX_SCAN_FILES + 5;
  const files = [];
  for (let i = 0; i < total; i++) files.push(path.join(dir, `writer-${i}.json`));
  await Promise.all(files.map((f) => writeFile(f, "{}")));
  const old = new Date(Date.now() - GC_SHARD_RETENTION_MS - 60_000);
  await Promise.all(files.map((f) => utimes(f, old, old)));

  await store.gc();
  const afterFirst = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  assert.equal(total - afterFirst.length, GC_MAX_SCAN_FILES);

  await store.gc();
  const afterSecond = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  assert.equal(afterSecond.length, 0);
});
