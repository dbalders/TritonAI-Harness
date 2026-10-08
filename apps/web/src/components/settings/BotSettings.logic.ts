import type { ServerBotTaskComputerStatus } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { DotTaskComputer } from "../dot/dotClient";

/** What the bot says about its task computer, from any Harness. */
export function describeTaskComputer(
  computer: DotTaskComputer | null | undefined,
  isThisComputer: boolean,
): string {
  if (computer === undefined) return "Your bot has not reported a task computer yet.";
  if (computer === null) {
    return "No computer runs approved Harness tasks. They wait until you choose Allow on one.";
  }
  const name = isThisComputer ? `${computer.deviceName} (this computer)` : computer.deviceName;
  if (computer.online) return `${name} is online and runs approved Harness tasks.`;
  return computer.lastSeenAt
    ? `${name} runs approved Harness tasks but is offline. Last checked in ${formatRelativeTimeLabel(computer.lastSeenAt)}.`
    : `${name} runs approved Harness tasks but has not checked in yet.`;
}

/** What this computer's Harness is doing for the bot. */
export function describeThisComputer(status: ServerBotTaskComputerStatus | null): string {
  if (!status) return "Checking this computer…";
  switch (status.state) {
    case "off":
      return (
        status.message ??
        "Choose Allow to run approved Harness tasks here. Any other computer stops claiming tasks."
      );
    case "replaced":
      return status.message ?? "Another computer now runs your TritonAI Bot tasks.";
    case "error":
      return status.message ?? "TritonAI Bot tasks hit a problem. Retrying.";
    case "running":
      return status.currentTask
        ? `Running “${status.currentTask.title}” in a Harness thread.`
        : "Running a task.";
    case "idle":
      return status.lastCheckInAt
        ? `Waiting for approved tasks. Last checked in ${formatRelativeTimeLabel(status.lastCheckInAt)}.`
        : "Waiting for approved tasks.";
  }
}

/**
 * Whether this computer is the bot's task computer. The bot is the authority;
 * the local state only fills in before the bot's state loads.
 */
export function isTaskComputer(
  remote: DotTaskComputer | null | undefined,
  local: ServerBotTaskComputerStatus | null,
): boolean {
  if (remote !== undefined) return remote !== null && remote.deviceId === local?.deviceId;
  return (
    local !== null &&
    (local.state === "idle" || local.state === "running" || local.state === "error")
  );
}
