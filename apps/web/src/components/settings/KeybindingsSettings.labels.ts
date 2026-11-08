import type { KeybindingCommand } from "@t3tools/contracts";
import { METRIC_OPTIONS, WINDOW_OPTIONS } from "../usage/usageShortcuts";

export function commandLabel(command: KeybindingCommand): string {
  if (command === "composer.sendAlternate") return "Composer: Opposite Queue or Steer Action";
  if (command === "composer.sendBackground") return "Composer: Start in Background";
  if (command === "composer.sendAndNewThread") return "Composer: Send and Start New Thread";
  if (command === "thread.steerQueuedMessage") return "Queue: Send First Queued Message as Steer";
  if (command === "thread.editQueuedMessage") return "Queue: Edit Last Queued Message";
  if (command === "thread.copyReference") return "Pull Request: Copy Link or Thread ID";
  const usageMetric = METRIC_OPTIONS.find((option) => option.command === command);
  if (usageMetric) return `Usage: ${usageMetric.label}`;
  const usagePeriod = WINDOW_OPTIONS.find((option) => option.command === command);
  if (usagePeriod) return `Usage: Period: ${usagePeriod.label}`;
  if (command === "view.reopenClosed") return "Reopen Closed Tab";
  if (command === "preview.focusUrl") return "Preview: Focus URL";
  const raw = String(command);
  if (raw.startsWith("script.") && raw.endsWith(".run")) {
    return `Run Script: ${titleCaseCommandSegment(raw.slice("script.".length, -".run".length))}`;
  }
  return raw.split(".").map(titleCaseCommandSegment).join(": ");
}

function titleCaseCommandSegment(segment: string): string {
  const words: Array<string> = [];
  for (const part of segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[-_\s]+/)) {
    if (part.length > 0) {
      words.push(part.slice(0, 1).toUpperCase() + part.slice(1));
    }
  }
  return words.join(" ");
}
