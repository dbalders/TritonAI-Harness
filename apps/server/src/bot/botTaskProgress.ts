import type { BotTaskThread } from "./BotTaskRuntime.ts";
/** Bounded public progress for the owner's Bot. Tool payloads and reasoning never cross this boundary. */
import type { BotTaskThreadProgress } from "@t3tools/contracts";
import type { HeldTask } from "./botTaskWork.ts";

export const BOT_TASK_CAPABILITIES = [
  "file-attachments-v1",
  "task-progress-v1",
  "task-followup-v1",
  "task-projects-v1",
] as const;
export const MAX_HELD_TASKS = 16;
export const MAX_CLAIMS_PER_PASS = 4;

/** Character and byte bounds apply before JSON encoding, including escaping. */
function clipTaskText(text: string, chars: number, bytes = chars * 3): string {
  let clipped = text.slice(0, chars);
  if (/[\uD800-\uDBFF]$/u.test(clipped)) clipped = clipped.slice(0, -1);
  while (Buffer.byteLength(JSON.stringify(clipped)) > bytes) {
    clipped = Array.from(clipped).slice(0, -1).join("");
  }
  return clipped;
}

function pendingCount(thread: BotTaskThread | null, kind: string, pending: boolean): number {
  if (!pending) return 0;
  const requests = new Set<string>();
  for (const activity of thread?.activities ?? []) {
    if (activity.kind !== `${kind}.requested` && activity.kind !== `${kind}.resolved`) continue;
    const payload = activity.payload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("requestId" in payload) ||
      typeof payload.requestId !== "string"
    )
      continue;
    if (activity.kind.endsWith(".requested")) requests.add(payload.requestId);
    else requests.delete(payload.requestId);
  }
  return Math.max(1, requests.size);
}

export function botTaskSnapshot(
  held: HeldTask,
  context: { readonly deviceId: string; readonly projectId: string; readonly observedAt: string },
  shell: BotTaskThread | null,
  thread: BotTaskThread | null,
): BotTaskThreadProgress {
  const pendingApprovals = pendingCount(thread, "approval", shell?.hasPendingApprovals === true);
  const pendingUserInputs = pendingCount(thread, "user-input", shell?.hasPendingUserInput === true);
  const ownMessage = thread?.messages.find((message) => message.id === held.messageId);
  const phase =
    held.outcome?.status ??
    (!held.started ||
    !ownMessage ||
    (held.previousTurnId !== undefined && shell?.latestTurn?.turnId === held.previousTurnId)
      ? "starting"
      : pendingApprovals
        ? "waiting-approval"
        : pendingUserInputs
          ? "waiting-input"
          : shell?.session?.status === "error"
            ? "failed"
            : shell?.latestTurn?.state === "completed" && shell?.session?.status !== "running"
              ? "completed"
              : shell?.latestTurn?.state === "error" || shell?.latestTurn?.state === "interrupted"
                ? "failed"
                : shell?.session?.status === "ready"
                  ? "idle"
                  : "running");
  const progress = {
    version: 1,
    ...context,
    threadId: held.threadId,
    title: clipTaskText(shell?.title ?? held.title, 120),
    phase,
    pendingApprovals,
    pendingUserInputs,
    messages: (thread?.messages ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-6)
      .map((message) => ({
        role: message.role as "user" | "assistant",
        text: clipTaskText(message.text, 1000, 1800),
        createdAt: message.createdAt || context.observedAt,
      })),
    activity: (thread?.activities ?? [])
      .filter((activity) => !/reasoning|thinking|analysis|compaction/iu.test(activity.kind))
      .slice(-5)
      .map((activity) => ({
        kind: clipTaskText(activity.kind, 80, 200),
        summary: clipTaskText(activity.summary, 240, 500),
        createdAt: activity.createdAt || context.observedAt,
      })),
  } satisfies BotTaskThreadProgress;
  // Keep a defensive envelope bound even if timestamps or future enum strings grow.
  while (Buffer.byteLength(JSON.stringify(progress)) >= 24 * 1024) {
    if (progress.messages.length) progress.messages.pop();
    else if (progress.activity.length) progress.activity.pop();
    else break;
  }
  return progress;
}

export function consumesBotLaunchSlot(progress: BotTaskThreadProgress): boolean {
  return (
    progress.phase !== "waiting-approval" &&
    progress.phase !== "waiting-input" &&
    progress.phase !== "completed" &&
    progress.phase !== "failed"
  );
}
