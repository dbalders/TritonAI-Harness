/**
 * Public owner-client contract for the bot's optional waiting explanations (`enhancements.waitingReasons`).
 * The service derives each one from stored records; clients branch on `code` and `action`, never on `text`.
 */
export type DotWaitingOn = "you" | "computer" | "connection" | "bot" | "nothing" | "unknown";

export interface DotWaitingAction {
  readonly kind:
    | "reply"
    | "decide"
    | "decline"
    | "review"
    | "inspect"
    | "resume-bot"
    | "resume-recipe"
    | "reconnect"
    | "task-computer"
    | "open"
    | "start";
  readonly label: string;
  readonly target?: {
    readonly kind: "approval" | "task" | "run" | "responsibility" | "recipe";
    readonly id: string;
  };
}

/** The record's own scheduled check, an owner event that wakes it, or a plain statement that nothing is scheduled. */
export type DotNextStep =
  | { readonly kind: "check"; readonly at: string; readonly what: string }
  | { readonly kind: "event"; readonly what: string }
  | { readonly kind: "none"; readonly what: string };

export interface DotWaitingStatus {
  /** Newer services may add codes; unknown ones still render their text. */
  readonly code: string;
  readonly on: DotWaitingOn;
  /** queued, claimed, running, returned, verified, deferred, uncertain or settled. Returned is never verified. */
  readonly phase?: string;
  readonly text: string;
  readonly action?: DotWaitingAction;
  readonly confirmed?: { readonly at: string; readonly what: string };
  readonly next: readonly DotNextStep[];
  /** The status changes by time alone then (a claim or lease ends, a check-in goes stale). */
  readonly changesAt?: string;
  readonly notes?: readonly string[];
}

/** How a reply in a responsibility's history ended, from its record and its run. */
export interface DotReplyOutcome {
  readonly code: string;
  readonly text: string;
  /** Present when the run that says how it ended isn't in the snapshot: opens that run in the conversation. */
  readonly action?: DotWaitingAction;
}

export const WAITING_ON_LABELS: Record<DotWaitingOn, string> = {
  you: "Waiting on you",
  computer: "Waiting on your task computer",
  connection: "Waiting on your Microsoft connection",
  bot: "Waiting on the bot",
  nothing: "Not waiting",
  unknown: "Status unknown",
};

const time = (value: string | undefined) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Malformed explanations are dropped, so an older or partial response keeps the panel's existing wording. */
export function usableWaiting(value: unknown): DotWaitingStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const status = value as Partial<DotWaitingStatus>;
  if (typeof status.code !== "string" || typeof status.text !== "string" || !status.text.trim())
    return undefined;
  if (!(typeof status.on === "string" && status.on in WAITING_ON_LABELS)) return undefined;
  if (!Array.isArray(status.next) || status.next.length === 0) return undefined;
  return status as DotWaitingStatus;
}

/** A scheduled check whose time has passed is overdue; it is never shown as upcoming. */
function isOverdue(step: DotNextStep, now: number): boolean {
  return step.kind === "check" && (time(step.at) ?? Infinity) <= now;
}

/** The status's own time-driven change has passed without a newer snapshot replacing it. */
function hasExpired(status: DotWaitingStatus, now: number): boolean {
  return (time(status.changesAt) ?? Infinity) <= now;
}

/** The next time this status reads differently without new data: one wake, not a repaint loop. */
export function nextWake(status: DotWaitingStatus, now: number): number | undefined {
  const times = [
    time(status.changesAt),
    ...status.next.map((step) => (step.kind === "check" ? time(step.at) : undefined)),
  ].filter((value): value is number => value !== undefined && value > now);
  return times.length ? Math.min(...times) : undefined;
}

/** What a status shows at `now`: overdue checks, a passed change time, and the one wake to read it again. */
export function waitingTimes(status: DotWaitingStatus, now = Date.now()) {
  return {
    overdue: status.next.map((step) => isOverdue(step, now)),
    expired: hasExpired(status, now),
    wake: nextWake(status, now),
  };
}
