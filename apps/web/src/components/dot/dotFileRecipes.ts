import type { DotApproval, DotTask } from "./dotClient";
import type { DotWaitingStatus } from "./dotWaiting";

export type DotFileRecipeEventStatus =
  | "settling"
  | "queued"
  | "needs-decision"
  | "assigned"
  | "declined"
  | "blocked"
  | "skipped"
  | "not-started"
  | "removed"
  | "failed"
  | "uncertain";

/** One exact file version a recipe saw, from the bot's `/state` fileRecipes field. Names are untrusted display text. */
export interface DotFileRecipeEvent {
  readonly key: string;
  readonly version: {
    readonly itemId: string;
    readonly name: string;
    readonly cTag: string;
    readonly size: number;
    readonly lastModifiedDateTime: string;
    readonly webUrl: string;
  };
  readonly status: DotFileRecipeEventStatus;
  readonly seenAt: string;
  readonly manual?: boolean;
  readonly runId?: string;
  readonly approvalId?: string;
  readonly taskId?: string;
  /** What the run read: a digest of the downloaded bytes and how much text reached the assignment. */
  readonly read?: {
    readonly sha256: string;
    readonly extension: string;
    readonly characters: number;
    readonly includedCharacters: number;
    readonly complete: boolean;
    readonly note?: string;
  };
  readonly reason?: string;
  readonly updatedAt: string;
  /** False when the event belongs to an earlier recipe configuration. */
  readonly current: boolean;
  /** The owner may explicitly Start this file now. */
  readonly startable: boolean;
  /** Where an unfinished file is, from its run, decision or assignment; absent for finished files and older services. */
  readonly waiting?: DotWaitingStatus;
}

export interface DotFileRecipe {
  readonly recipeId: string;
  readonly name: string;
  readonly instructions: string;
  readonly expectedOutput: string;
  readonly approval: "ask" | "review";
  readonly folder: { readonly folderId: string; readonly name: string; readonly webUrl: string };
  readonly status: "active" | "paused" | "stopped";
  readonly pausedReason?: "owner" | "connection-changed" | "folder-unavailable";
  /** Owner changes advance it; send it back so a stale screen cannot change a newer recipe. */
  readonly generation: number;
  /** Advances on every write; a client keeps the newest it has seen. Absent on older services. */
  readonly version?: number;
  readonly cadence: string;
  readonly coverage?: {
    readonly complete: boolean;
    readonly files: number;
    readonly folders: number;
    readonly other: number;
    readonly checkedAt: string;
    readonly notListed?: number;
  };
  readonly rebaselinePending?: boolean;
  /**
   * Present while `open` unfinished files already fill the recipe's `limit`: `waiting` newer files stay in the folder,
   * unrecorded, and are picked up automatically once decisions or other changes make room.
   */
  readonly blocked?: {
    readonly waiting: number;
    readonly open: number;
    readonly limit: number;
    readonly since: string;
  };
  readonly nextCheckAt?: string;
  readonly lastCheckedAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastError?: string;
  readonly lastErrorCode?: string;
  /** Why the recipe waits and its real next check; absent on older services. */
  readonly waiting?: DotWaitingStatus;
  /** Newest first. */
  readonly events: readonly DotFileRecipeEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DotRecipeFolderListing {
  readonly folder: { readonly folderId: string; readonly name: string; readonly webUrl: string };
  readonly subfolders: ReadonlyArray<{
    readonly folderId: string;
    readonly name: string;
    readonly webUrl: string;
  }>;
  readonly files: number;
  /** False when the folder has more than one bounded page of items; a recipe cannot watch it. */
  readonly complete: boolean;
  readonly note?: string;
}

export interface DotFileRecipeInput {
  readonly name: string;
  readonly instructions: string;
  readonly expectedOutput: string;
  readonly approval: "ask" | "review";
}

export type DotFileRecipeAction = "pause" | "resume" | "stop";

const EVENT_LABELS = {
  settling: "Waiting until the file stops changing",
  queued: "Starting",
  "needs-decision": "Needs your decision",
  assigned: "Assigned to Harness",
  declined: "Declined",
  blocked: "Blocked by the automatic review",
  skipped: "Skipped",
  "not-started": "Not started",
  removed: "Left the folder",
  failed: "Did not start",
  uncertain: "Checking what happened",
} satisfies Record<DotFileRecipeEventStatus, string>;

export function fileRecipeEventLabel(event: DotFileRecipeEvent): string {
  return EVENT_LABELS[event.status];
}

/**
 * The decision or assignment state behind an event, from the approval and task records in the same `/state`
 * snapshot. Those records are authoritative; the recipe event only links to them.
 */
export function fileRecipeEventProgress(
  event: DotFileRecipeEvent,
  approvals: readonly DotApproval[],
  tasks: readonly DotTask[],
): string | undefined {
  if (event.taskId) {
    const task = tasks.find((item) => item.taskId === event.taskId);
    // Older assignments can fall outside the newest tasks in a snapshot; that says nothing about their state.
    if (!task) return "This assignment isn't in this view. Open it to see its current state.";
    if (task.status === "completed") return "Harness returned a result.";
    if (task.status === "failed") return "Harness reported a failure.";
    if (task.status === "uncertain")
      return "Harness execution could not be confirmed. Check the task before starting again.";
    if (task.status === "cancelled") return task.result ?? "Cancelled before it started.";
    return "Waiting for or running on your Harness task computer.";
  }
  if (event.approvalId && event.status === "needs-decision") {
    const approval = approvals.find((item) => item.approvalId === event.approvalId);
    if (!approval)
      return "This file's decision isn't in this view. Open it to see its current state.";
    return approval.notStartable
      ? `This assignment can no longer start: ${approval.notStartable} Decline it.`
      : "Waiting in your decision inbox. Nothing starts until you approve it.";
  }
  return undefined;
}

/** A plain description of what the run actually read, or undefined before anything was read. */
export function fileRecipeReadSummary(event: DotFileRecipeEvent): string | undefined {
  if (!event.read) return undefined;
  const included = `${event.read.includedCharacters.toLocaleString()} of ${event.read.characters.toLocaleString()} extracted characters`;
  return `${event.read.complete ? "Complete text" : "Partial text"} sent: ${included}. SHA-256 ${event.read.sha256.slice(0, 12)}…${event.read.note ? ` ${event.read.note}` : ""}`;
}

/** The owner-facing blocker and its recovery when a recipe holds as many unfinished files as it can. */
export function fileRecipeBlockedText(blocked: NonNullable<DotFileRecipe["blocked"]>): string {
  const waiting = blocked.waiting === 1 ? "1 newer file is" : `${blocked.waiting} newer files are`;
  return (
    `This recipe already holds ${blocked.open} unfinished files, the most it holds at once: they are waiting for your decision or in progress. ` +
    `${waiting} still in the folder and will be picked up automatically once there is room. ` +
    "To make room, approve or decline waiting decisions in your decision inbox, or pause the recipe; pausing lists the newer files for you to start instead."
  );
}

/** Only https links from the service are opened; anything else stays plain text. */
export function safeRecipeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
