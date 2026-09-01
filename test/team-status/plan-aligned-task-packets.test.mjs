import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const taskPackets = readFileSync(
  new URL("../../skills/team-orchestration/references/task-packets.md", import.meta.url),
  "utf8",
);
const skill = readFileSync(
  new URL("../../skills/team-orchestration/SKILL.md", import.meta.url),
  "utf8",
);
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

test("task-packet protocol preserves general mode and adds explicit plan alignment", () => {
  assert.match(taskPackets, /## 无计划模式/);
  assert.match(taskPackets, /## 计划对齐模式/);
  assert.match(taskPackets, /计划文件/);
  assert.match(taskPackets, /原生执行单元/);
  assert.match(taskPackets, /不得.*静默.*切换.*无计划模式/);
});

test("Superpowers plans keep one complete Task as one executor and review unit", () => {
  assert.match(taskPackets, /一个完整的 `### Task N`/);
  assert.match(taskPackets, /task-brief PLAN_FILE N/);
  assert.match(taskPackets, /不得把 Task 内的 Step 再拆成不同 executor 任务包/);
  assert.match(taskPackets, /executor 不读取整个计划文件/);
});

test("mechanical readiness returns unresolved work to the leader", () => {
  assert.match(taskPackets, /### 机械就绪检查/);
  assert.match(taskPackets, /精确文件或代码锚点/);
  assert.match(taskPackets, /具体验证命令与预期结果/);
  assert.match(taskPackets, /返回领导者裁决/);
  assert.match(skill, /计划原生执行单元/);
  assert.match(skill, /机械就绪检查/);
});

test("README documents general and plan-aligned task-packet modes", () => {
  assert.match(readme, /无计划.*四要素任务包/s);
  assert.match(readme, /有计划.*原生执行单元/s);
  assert.match(readme, /Superpowers.*`### Task N`/s);
});
