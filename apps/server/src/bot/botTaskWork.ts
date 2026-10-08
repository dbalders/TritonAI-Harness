/**
 * How a TritonAI Bot task held by this computer is turned into a Harness thread
 * and back into a result. The decisions here are pure so restart recovery is
 * testable: a task is never started twice, and a task whose thread cannot show
 * it ran is reported as not run rather than retried.
 */
import type { OrchestrationThread } from "@t3tools/contracts";

/** A task this computer claimed. Saved before its thread is created. */
export interface HeldTask {
  readonly taskId: string;
  readonly claimId: string;
  readonly title: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly claimedAt: string;
  /**
   * Set after the thread exists and just before its turn is requested. Before
   * that, nothing can have run.
   */
  readonly started: boolean;
  /** Saved before delivery so a failed delivery is retried, never rerun. */
  readonly outcome: TaskOutcome | null;
}

export interface TaskOutcome {
  readonly status: "completed" | "failed";
  readonly result: string;
}

export type TaskProgress = { readonly kind: "pending" } | ({ readonly kind: "done" } & TaskOutcome);

/** Work left this long is reported so the bot is not left waiting indefinitely. */
export const HELD_TASK_LIMIT_MS = 24 * 3_600_000;
/** A thread that never received the task's message this long after the claim never started it. */
export const START_GRACE_MS = 5 * 60_000;
const NOTHING_RAN =
  "Harness stopped before this task started, so nothing ran. Ask for it again to retry.";
const MAX_RESULT_BYTES = 90_000;

export function taskPrompt(title: string, prompt: string): string {
  return `TritonAI Bot assignment: ${title}\n\nThe owner reviewed and approved this brief. Return the deliverable as your final reply.\n\n${prompt}`;
}

/** Bot task threads keep the bot's title; an empty title falls back to a generic one. */
export function taskThreadTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim().slice(0, 120) || "TritonAI Bot task";
}

/** Only HTTPS, or plain HTTP on this computer for development, may receive the owner session. */
export function normalizeBotApiUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function capResult(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_RESULT_BYTES) return text;
  return `${new TextDecoder().decode(bytes.slice(0, MAX_RESULT_BYTES)).replace(/�$/u, "")}\n\n[Truncated. Open the Harness thread for the full reply.]`;
}

/**
 * Reads the task's turn from its thread: the assistant messages after the
 * task's own message, up to the owner's next message in the same thread.
 */
export function taskProgress(
  thread: OrchestrationThread | null,
  held: HeldTask,
  now: number,
): TaskProgress {
  if (!held.started) return { kind: "done", status: "failed", result: NOTHING_RAN };
  if (!thread || thread.deletedAt !== null) {
    return {
      kind: "done",
      status: "failed",
      result:
        "The Harness thread for this task was deleted before it finished, so its result is unknown. Check for any changes it made before asking again.",
    };
  }
  const reference = `Harness thread: ${thread.title}`;
  const start = thread.messages.findIndex((message) => message.id === held.messageId);
  if (start === -1 && now - Date.parse(held.claimedAt) > START_GRACE_MS) {
    return { kind: "done", status: "failed", result: `${NOTHING_RAN}\n\n${reference}` };
  }
  const following = start === -1 ? [] : thread.messages.slice(start + 1);
  const next = following.findIndex((message) => message.role === "user");
  const replies = (next === -1 ? following : following.slice(0, next)).filter(
    (message) => message.role === "assistant",
  );
  // Follow-up turns can supersede a running assignment. Their existence proves no terminal outcome.
  if (next !== -1) {
    const partial = replies
      .map((message) => message.text.trim())
      .filter(Boolean)
      .join("\n\n");
    return {
      kind: "done",
      status: "failed",
      result: capResult(
        `The assignment's outcome could not be confirmed after a follow-up started. Check this Harness thread before asking again.${partial ? `\n\nEarlier reply (unconfirmed):\n${partial}` : ""}\n\n${reference}`,
      ),
    };
  }
  const sessionBusy = thread.session?.status === "running" || thread.session?.status === "starting";
  const turnRunning = thread.latestTurn === null || thread.latestTurn.state === "running";
  const finished =
    start !== -1 && !sessionBusy && !turnRunning && replies.every((message) => !message.streaming);
  if (!finished) {
    if (now - Date.parse(held.claimedAt) > HELD_TASK_LIMIT_MS) {
      return {
        kind: "done",
        status: "failed",
        result: capResult(
          `This task was still unfinished after 24 hours. It may still be running; check it in Harness before asking again.\n\n${reference}`,
        ),
      };
    }
    return { kind: "pending" };
  }
  const text = replies
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const failed = thread.latestTurn?.state === "error" || thread.latestTurn?.state === "interrupted";
  if (failed) {
    const reason =
      thread.session?.lastError ??
      (thread.latestTurn?.state === "interrupted" ? "The turn was stopped." : "The turn failed.");
    return {
      kind: "done",
      status: "failed",
      result: capResult(`${reason}${text ? `\n\nPartial reply:\n${text}` : ""}\n\n${reference}`),
    };
  }
  return {
    kind: "done",
    status: "completed",
    result: capResult(`${text || "Finished without a written reply."}\n\n${reference}`),
  };
}
