import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTROL_EVENT = "subagent:control-event";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function registerTeamControl(pi: ExtensionAPI): void {
  const notified = new Set<string>();

  const unsubscribe = pi.events.on(CONTROL_EVENT, (payload) => {
    const details = asRecord(payload);
    const event = asRecord(details?.event);
    if (details?.source !== "async"
      || event?.type !== "active_long_running"
      || event.reason !== "time_threshold"
      || event.agent !== "executor"
      || typeof event.elapsedMs !== "number"
      || event.elapsedMs < 480_000
      || typeof event.runId !== "string"
      || !event.runId.trim()) return;

    const runId = event.runId.trim();
    const notificationKey = `${runId}:${typeof event.index === "number" ? event.index : ""}`;
    if (notified.has(notificationKey)) return;
    notified.add(notificationKey);

    const target = JSON.stringify(runId);

    pi.sendMessage({
      customType: "team-executor-soft-timeout",
      content: [
        "Executor 已达到 8 分钟软时限。不要立即停止或替换它。",
        `Run: ${runId}`,
        `先检查状态：subagent({ action: \"status\", id: ${target} })`,
        `再显式提醒：subagent({ action: \"steer\", id: ${target}, message: \"已超过软时限。请在当前工具结束后汇报 changed files、测试状态、剩余工作与阻塞；等待 Leader 决定继续或收敛。\" })`,
        "根据 checkpoint 决定继续、要求尽快收敛，或用 interrupt 可恢复暂停。",
      ].join("\n"),
      display: true,
    }, { triggerTurn: true });
  });

  pi.on("session_shutdown", () => {
    if (typeof unsubscribe === "function") unsubscribe();
    notified.clear();
  });
}
