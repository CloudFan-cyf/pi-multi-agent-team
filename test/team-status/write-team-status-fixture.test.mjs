/**
 * Team 团队可视化 — 确定性 fixture 脚本（Task 9）单测。
 *
 * 覆盖 CLI 参数校验（缺参 / 非正时长 → exit 2）、运行时写入 Leader+Executor
 * shard（生产 store/reducer 路径）、以及 exit/signal 后清理无残留。
 *
 * 所有真实文件系统测试都在 mkdtemp 隔离目录内进行；fixture 进程以
 * `node --experimental-strip-types` 独立 spawn（与生产用法一致），不 import
 * 脚本内部实现，只通过文件系统与退出码做行为断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import { TEAM_STATUS_KIND, TEAM_STATUS_VERSION } from "../../extensions/team-status/types.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "write-team-status-fixture.mjs");

const NODE = process.execPath;
const STRIP_TYPES = "--experimental-strip-types";

/** 递归收集某目录下所有 .json / .tmp / .bak 文件。 */
async function collectShardFiles(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(json|tmp|bak)$/.test(entry.name)) found.push(full);
    }
  }
  await walk(path.join(root, "team-status", "v1"));
  return found;
}

/** 递归收集某目录下所有 .json 文件内容（解析后），供运行时断言。 */
async function collectShards(root) {
  const files = await collectShardFiles(root);
  const shards = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      shards.push(parsed);
    } catch {
      // 半写竞态：跳过。
    }
  }
  return shards;
}

function runFixture(args, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [STRIP_TYPES, SCRIPT, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolve({ code: null, signal: null, stdout, stderr, error: err.message }));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function makeTempAgentDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "team-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

test("fixture script file exists (precondition for spawning)", async () => {
  await stat(SCRIPT); // throws if missing
});

test("missing --agent-dir exits 2 with a diagnostic", async () => {
  const result = await runFixture(["--session-id", "fixture-session"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /agent-dir/i);
});

test("missing --session-id exits 2 with a diagnostic", async () => {
  const result = await runFixture(["--agent-dir", os.tmpdir()]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /session-id/i);
});

test("non-positive --duration-ms exits 2", async (t) => {
  const agentDir = await makeTempAgentDir(t);
  for (const bad of ["0", "-5", "abc"]) {
    const result = await runFixture([
      "--agent-dir", agentDir,
      "--session-id", "fixture-session",
      "--duration-ms", bad,
    ]);
    assert.equal(result.code, 2, `--duration-ms ${bad} should exit 2`);
  }
  assert.deepEqual(await collectShardFiles(agentDir), []);
});

test("valid run exits 0 and leaves no shard files behind", async (t) => {
  const agentDir = await makeTempAgentDir(t);
  const result = await runFixture([
    "--agent-dir", agentDir,
    "--session-id", "fixture-session",
    "--duration-ms", "100",
  ]);
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.deepEqual(await collectShardFiles(agentDir), []);
});

test("writes a live Leader+Executor shard via production store while running, then cleans up", async (t) => {
  const agentDir = await makeTempAgentDir(t);
  const sessionId = "fixture-session-live";
  const child = spawn(NODE, [STRIP_TYPES, SCRIPT, "--agent-dir", agentDir, "--session-id", sessionId, "--duration-ms", "3000"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  // 等待生产 store 写出 shard（首次写入在启动后立即发生）。
  const shards = await waitFor(async () => {
    const found = await collectShards(agentDir);
    return found.length > 0 ? found : undefined;
  }, 5000);
  assert.ok(shards, "fixture should write a shard shortly after start");
  const shard = shards[0];
  assert.equal(shard.kind, TEAM_STATUS_KIND);
  assert.equal(shard.version, TEAM_STATUS_VERSION);
  assert.equal(shard.sessionId, sessionId);
  assert.equal(shard.writerId, "fixture");
  const roles = shard.members.map((m) => m.role).sort();
  assert.ok(roles.includes("leader"), `members should include a leader: ${JSON.stringify(roles)}`);
  assert.ok(roles.includes("executor"), `members should include an executor: ${JSON.stringify(roles)}`);
  assert.ok(shard.members.every((m) => m.state === "running"));

  const exit = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.code, 0, `stderr: ${stderr}`);
  assert.deepEqual(await collectShardFiles(agentDir), []);
});
