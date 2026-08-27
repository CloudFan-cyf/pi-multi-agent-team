/**
 * Team 团队可视化 — 跨进程 shard 原子存储（Task 3）。
 *
 * 每个 session 拥有独立的哈希 namespace；writer 以 `<writerId>.json` 写入自己的
 * shard。写入采用「同目录唯一 .tmp → rename」的原子替换：Windows 上 rename 不能
 * 覆盖既有目标（EEXIST/EPERM/EACCES），因此把旧目标挪到唯一 .bak、再把完整 .tmp
 * rename 到位；第二次 rename 失败则恢复 .bak。替换瞬间读者最多看到「目标短暂缺失」，
 * 绝不看到半个 JSON；上一份内存快照由 controller 保留（见 Task 8）。
 *
 * read() 对解析/读取竞态做容错：损坏、半写、未知 version/kind、异 session 的文件
 * 一律跳过，返回有效 shard 数组。gc() 对 `team-status/v1` 基目录做有界清理：
 * 删除超过 24 小时的 `.json`、超过安全窗口的 `.tmp`，单次最多检查 GC_MAX_SCAN_FILES
 * 个文件，避免启动时无界扫描。Unix 下目录/文件尽力使用 0o700/0o600。
 *
 * 本模块不 import `aggregateRuntimeShards`：read() 按测试契约返回原始 shard 数组，
 * 聚合由 controller（Task 8）完成。
 */
import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import * as fsp from "node:fs/promises";
import { MAX_MEMBERS, MAX_SHARD_BYTES, TEAM_STATUS_KIND, TEAM_STATUS_VERSION, type TeamRuntimeShardV1 } from "./types.ts";

/** 超过 24 小时的 shard 被 gc 删除。 */
export const GC_SHARD_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 超过 1 小时的孤立 .tmp 被 gc 删除（写入远快于该窗口，可安全判为残留）。 */
export const GC_TMP_RETENTION_MS = 60 * 60 * 1000;
/** 单次 gc 最多检查的文件数（有界扫描上限）。 */
export const GC_MAX_SCAN_FILES = 256;

/** session namespace 的稳定哈希前缀（与设计规格 §5.3 一致）。 */
const NAMESPACE_PREFIX = "pi-multi-agent-team:v1";

/** 存储依赖的文件系统操作，注入仅用于测试（替换失败模拟 / 权限请求断言）。 */
export interface ShardFileOps {
  mkdir(path: string, options: { recursive: boolean; mode?: number }): Promise<unknown>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number; isFile(): boolean }>;
}

export const defaultShardFileOps: ShardFileOps = {
  mkdir: (path, options) => fsp.mkdir(path, options),
  writeFile: (path, data, options) => fsp.writeFile(path, data, options),
  rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
  unlink: (path) => fsp.unlink(path),
  readFile: (path, encoding) => fsp.readFile(path, encoding),
  readdir: (path) => fsp.readdir(path),
  stat: (path) => fsp.stat(path),
};

export interface TeamShardStoreOptions {
  agentDir: string;
  ops?: ShardFileOps;
  now?: () => number;
  randomUUID?: () => string;
}

/** session 的隔离目录：`<agentDir>/team-status/v1/sha256(prefix + sessionId)`。 */
export function sessionNamespace(agentDir: string, sessionId: string): string {
  const digest = createHash("sha256").update(`${NAMESPACE_PREFIX}:${sessionId}`).digest("hex");
  return join(resolve(agentDir), "team-status", "v1", digest);
}

/** 保守的便携文件名白名单：仅允许 [A-Za-z0-9._-]。显式排除 `/`、`\`、`:`、`*`、
 *  `?`、`"`、`<`、`>`、`|` 等 Unix/Windows 路径或保留字符，防止 writerId 被用作
 *  文件名时产生路径穿越或平台兼容问题。 */
const WRITER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function isPathSafeWriterId(writerId: unknown): writerId is string {
  return typeof writerId === "string" && WRITER_ID_PATTERN.test(writerId);
}

function assertPathSafeWriterId(writerId: unknown): asserts writerId is string {
  if (!isPathSafeWriterId(writerId)) {
    throw new TypeError("writerId must be a non-empty portable filename ([A-Za-z0-9._-])");
  }
}

/**
 * 读写共享的 shard 结构校验：返回命中的违规字段，否则返回 undefined。
 * write() 与 parseRuntimeShard 共用同一套规则，保证读写校验永不刻意分叉。
 */
function shardShapeViolation(
  shard: Record<string, unknown>,
  expectedSessionId: string,
): "kind" | "version" | "sessionId" | "writerId" | "heartbeatAt" | "members" | "too-many-members" | undefined {
  if (shard.kind !== TEAM_STATUS_KIND) return "kind";
  if (shard.version !== TEAM_STATUS_VERSION) return "version";
  if (shard.sessionId !== expectedSessionId) return "sessionId";
  if (!isPathSafeWriterId(shard.writerId)) return "writerId";
  if (typeof shard.heartbeatAt !== "number" || !Number.isFinite(shard.heartbeatAt)) return "heartbeatAt";
  if (!Array.isArray(shard.members)) return "members";
  if (shard.members.length > MAX_MEMBERS) return "too-many-members";
  return undefined;
}

/**
 * 解析并校验一个 shard 文本。仅接受同 session、同 kind/version、且结构完整
 * （writerId / heartbeatAt / members 存在）的对象；其余一律返回 undefined。
 * 消费者（read）据此跳过损坏、半写或异 session 的文件。
 */
export function parseRuntimeShard(value: string, expectedSessionId: string): TeamRuntimeShardV1 | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const shard = parsed as Record<string, unknown>;
  if (shardShapeViolation(shard, expectedSessionId)) return undefined;
  return shard as unknown as TeamRuntimeShardV1;
}

export class TeamShardStore {
  private readonly agentDir: string;
  private readonly ops: ShardFileOps;
  private readonly now: () => number;
  private readonly randomUUID: () => string;

  constructor(options: TeamShardStoreOptions) {
    this.agentDir = options.agentDir;
    this.ops = options.ops ?? defaultShardFileOps;
    this.now = options.now ?? (() => Date.now());
    this.randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  async write(shard: TeamRuntimeShardV1): Promise<void> {
    const sessionId = shard.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("shard.sessionId must be a non-empty string");
    }

    // 与 read() 共用同一套结构校验（parseRuntimeShard 的 shardShapeViolation），
    // 避免写入与读取对 kind/version/members 等约束产生分叉。
    const violation = shardShapeViolation(shard as unknown as Record<string, unknown>, sessionId);
    if (violation === "too-many-members") {
      throw new RangeError(`shard.members exceeds MAX_MEMBERS=${MAX_MEMBERS} (${shard.members.length})`);
    }
    if (violation === "writerId") {
      throw new TypeError("shard.writerId must be a non-empty portable filename ([A-Za-z0-9._-])");
    }
    if (violation !== undefined) {
      throw new TypeError(`invalid shard: ${violation}`);
    }
    const writerId = shard.writerId;

    const serialized = JSON.stringify(shard);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_SHARD_BYTES) {
      throw new RangeError(`serialized shard exceeds ${MAX_SHARD_BYTES} bytes (${bytes})`);
    }

    const dir = sessionNamespace(this.agentDir, sessionId);
    await this.ops.mkdir(dir, { recursive: true, mode: 0o700 });

    const tmp = join(dir, `.${writerId}.${this.randomUUID()}.tmp`);
    const target = join(dir, `${writerId}.json`);
    await this.ops.writeFile(tmp, serialized, { mode: 0o600 });

    try {
      await this.ops.rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw err;
    }

    // Windows 覆盖冲突：把旧目标挪到唯一 .bak，再把完整 .tmp rename 到位；
    // 第二次 rename 失败则恢复 .bak，成功则删除 .bak。
    const backup = join(dir, `.${writerId}.${this.randomUUID()}.bak`);
    try {
      await this.ops.rename(target, backup);
    } catch (err) {
      const moveCode = (err as NodeJS.ErrnoException)?.code;
      if (moveCode === "ENOENT") {
        // 没有既存目标（首次写入或目标被并发删除）：直接重试主 rename 一次。
        await this.ops.rename(tmp, target);
        return;
      }
      throw err;
    }
    try {
      await this.ops.rename(tmp, target);
    } catch (secondErr) {
      await this.ops.rename(backup, target).catch(() => {});
      throw secondErr;
    }
    await this.ops.unlink(backup).catch(() => {});
  }

  async read(sessionId: string): Promise<TeamRuntimeShardV1[]> {
    const dir = sessionNamespace(this.agentDir, sessionId);
    let names: string[];
    try {
      names = await this.ops.readdir(dir);
    } catch {
      return [];
    }
    names.sort();
    const shards: TeamRuntimeShardV1[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let text: string;
      try {
        text = await this.ops.readFile(join(dir, name), "utf8");
      } catch {
        continue; // 竞态：readdir 与 readFile 之间文件被删除。
      }
      const parsed = parseRuntimeShard(text, sessionId);
      if (parsed) shards.push(parsed);
    }
    return shards;
  }

  async remove(sessionId: string, writerId: string): Promise<void> {
    assertPathSafeWriterId(writerId);
    const dir = sessionNamespace(this.agentDir, sessionId);
    const target = join(dir, `${writerId}.json`);
    try {
      await this.ops.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }

  /** 有界 GC：清理 >24h 的 .json 与超过安全窗口的 .tmp，单次最多扫描 GC_MAX_SCAN_FILES 个文件。 */
  async gc(): Promise<void> {
    const baseDir = join(resolve(this.agentDir), "team-status", "v1");
    let sessionDirs: string[];
    try {
      sessionDirs = await this.ops.readdir(baseDir);
    } catch {
      return; // 基目录尚不存在：无物可清。
    }

    const now = this.now();
    let scanned = 0;
    for (const sessionName of sessionDirs) {
      if (scanned >= GC_MAX_SCAN_FILES) break;
      const sessionDir = join(baseDir, sessionName);
      let names: string[];
      try {
        names = await this.ops.readdir(sessionDir);
      } catch {
        continue; // 非目录项或已消失的目录。
      }
      for (const name of names) {
        if (scanned >= GC_MAX_SCAN_FILES) break;
        const file = join(sessionDir, name);
        scanned += 1;
        let info;
        try {
          info = await this.ops.stat(file);
        } catch {
          continue; // 竞态：扫描之间文件已消失。
        }
        if (!info.isFile()) continue;
        const age = now - info.mtimeMs;
        if (name.endsWith(".json") && age > GC_SHARD_RETENTION_MS) {
          await this.ops.unlink(file).catch(() => {});
        } else if (name.endsWith(".tmp") && age > GC_TMP_RETENTION_MS) {
          await this.ops.unlink(file).catch(() => {});
        }
      }
    }
  }
}
