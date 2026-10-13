/** Optional owner-service features; clients keep older services usable. */
export interface DotAttachment {
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly truncated?: boolean;
}

export interface DotStructuredResult {
  readonly version: 1;
  readonly summary: string;
  readonly execution: {
    readonly status: "completed" | "failed";
    readonly threadId: string;
    readonly messageId: string;
    readonly turnId?: string;
    readonly completedAt?: string;
  };
  readonly verification: { readonly status: "unverified" };
  readonly artifacts: ReadonlyArray<{
    readonly label: string;
    readonly uri: string;
    readonly kind: "artifact" | "source";
    readonly provenance: "assistant-reported" | "harness-upload";
    readonly attachmentId?: string;
  }>;
  readonly checks: ReadonlyArray<{
    readonly label: string;
    readonly status: "reported-pass" | "reported-fail" | "not-run";
    readonly provenance: "assistant-reported";
  }>;
  readonly blockers: readonly string[];
}

export interface DotResponsibility {
  readonly responsibilityId: string;
  readonly version: number;
  readonly title: string;
  readonly intendedOutcome: string;
  readonly source: { readonly kind: "harness-task"; readonly taskId: string };
  readonly completionCriteria: string;
  readonly nextAction: string;
  readonly allowedActions: readonly ("observe-task" | "notify-owner")[];
  readonly status:
    | "active"
    | "snoozed"
    | "needs-decision"
    | "needs-review"
    | "completed"
    | "cancelled";
  readonly nextWakeAt?: string;
  readonly linkedTaskIds: readonly string[];
  readonly linkedRunIds: readonly string[];
  readonly sourceEvidence?: {
    readonly taskId: string;
    readonly updatedAt: string;
    readonly status: string;
    readonly digest: string;
    readonly available: boolean;
  };
  readonly reviewedAt?: string;
  /** Absent on older services and on responsibilities that never used replies. */
  readonly replies?: DotResponsibilityReplies;
}

export type DotReplyIntent = "input" | "requirement" | "blocker" | "cancel" | "question";

/** One owner message the bot recorded for a responsibility. Its text lives in the message run. */
export interface DotResponsibilityReply {
  readonly seq: number;
  readonly runId: string;
  readonly sourceId: string;
  readonly channel: "teams" | "harness";
  readonly receivedAt: string;
  readonly intent: DotReplyIntent;
  readonly reason: string;
  readonly association: "explicit" | "matched" | "owner-selected";
  readonly handledByRunId?: string;
  readonly handledAt?: string;
  readonly notContinued?: string;
}

export interface DotResponsibilityReplies {
  readonly enabled: boolean;
  readonly awaiting?: { readonly input: string; readonly since: string };
  readonly received?: { readonly input: string; readonly seq: number; readonly at: string };
  readonly lastSeq: number;
  readonly requirementVersion: number;
  /** Advances on cancel, reopen and turning replies off; absent on older services. */
  readonly epoch?: number;
  readonly log: readonly DotResponsibilityReply[];
  readonly revisions: ReadonlyArray<{
    readonly seq: number;
    readonly runId: string;
    readonly at: string;
    readonly kind: "requirement" | "deadline";
    readonly text: string;
  }>;
}

/** A message the bot did not attach to any responsibility because more than one could fit. */
export interface DotHeldReply {
  readonly sourceId: string;
  readonly intent: DotReplyIntent;
  readonly classification: string;
  readonly reason: string;
  readonly candidates: ReadonlyArray<{ readonly responsibilityId: string; readonly title: string }>;
}

/** How the bot routed a sent message; absent for ordinary chat and from older services. */
export interface DotReplyRouting {
  readonly outcome: "continued" | "held" | "cancelled" | "not-continued";
  readonly reason: string;
  readonly responsibilityId?: string;
  readonly title?: string;
  readonly intent?: DotReplyIntent;
}

export type DotResponsibilityInput =
  | {
      readonly action: "create";
      readonly responsibilityId: string;
      readonly expectedVersion: 0;
      readonly title: string;
      readonly intendedOutcome: string;
      readonly source: DotResponsibility["source"];
      readonly completionCriteria: string;
      readonly nextAction: string;
    }
  | {
      readonly action: "update";
      readonly responsibilityId: string;
      readonly expectedVersion: number;
      readonly title: string;
      readonly intendedOutcome: string;
      readonly completionCriteria: string;
      readonly nextAction: string;
    }
  | {
      readonly action: "cancel" | "resume" | "reopen" | "stop-waiting";
      readonly responsibilityId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly action: "replies";
      readonly responsibilityId: string;
      readonly expectedVersion: number;
      readonly enabled: boolean;
    }
  | {
      readonly action: "wait";
      readonly responsibilityId: string;
      readonly expectedVersion: number;
      readonly input: string;
    }
  | {
      readonly action: "use-reply";
      readonly responsibilityId: string;
      readonly expectedVersion: number;
      readonly runId: string;
    }
  | {
      readonly action: "snooze";
      readonly responsibilityId: string;
      readonly expectedVersion: number;
      readonly until: string;
    }
  | {
      readonly action: "complete";
      readonly responsibilityId: string;
      readonly expectedVersion: number;
      readonly reviewedEvidence: true;
      readonly evidenceDigest: string;
    };

export interface DotMemoryInput {
  readonly action: "edit" | "save-preference";
  readonly memoryId: string;
  readonly expectedVersion: number;
  readonly text: string;
  readonly kind: "fact" | "preference" | "instruction";
  readonly scope: "owner";
  readonly reviewed?: true;
  readonly sourceRunId?: string;
}

/** Plain status after sending; ordinary chat and older services say nothing extra. */
export function replyRoutingText(reply: DotReplyRouting | undefined): string | null {
  if (!reply) return null;
  const title = reply.title ? `“${reply.title}”` : "the responsibility";
  if (reply.outcome === "continued") return `Continuing ${title}. ${reply.reason}`;
  if (reply.outcome === "cancelled")
    return `Stopped following ${title}. Reopen it under Responsibilities if this was a mistake.`;
  if (reply.outcome === "held")
    return `Not attached to a responsibility yet. ${reply.reason} Choose one under Responsibilities.`;
  return `Not continued: ${reply.reason}`;
}

export function botWebUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
