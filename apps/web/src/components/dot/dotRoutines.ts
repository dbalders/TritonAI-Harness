/** Owner-facing watch projection from the bot's optional `/state` watches field. */
export interface DotWatch {
  readonly watchId: string;
  readonly source: "github";
  readonly target: string;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly watching?: string;
  readonly status: "active" | "paused" | "expired" | "deleted";
  readonly delivery: "immediate" | "digest";
  readonly digestTime?: string;
  readonly until?: string;
  readonly cadence: string;
  readonly lastCheckedAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastError?: string;
  /** ISO timestamp, omitted when the watch is paused or expired. */
  readonly nextCheckAt?: string;
  readonly heldForDigest?: number;
  readonly createdAt: string;
}

export type DotPromptWeekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface DotPromptSchedule {
  readonly kind: "daily" | "weekdays" | "weekly" | "interval";
  readonly time?: string;
  readonly days?: readonly DotPromptWeekday[];
  readonly everyMinutes?: number;
  readonly window?: { readonly from: string; readonly to: string };
}

/** Public scheduled-prompt projection; contains no storage or deduplication state. */
export interface DotScheduledPrompt {
  readonly promptId: string;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: DotPromptSchedule;
  readonly scheduleText: string;
  readonly timezone: string;
  readonly threadId: string;
  readonly notify: "always" | "if-notable";
  readonly enabled: boolean;
  readonly pausedReason?: "owner" | "unread";
  readonly nextRunAt?: string;
  readonly nextRun?: string;
  readonly lastRun?: {
    readonly at: string;
    readonly outcome:
      | "notable"
      | "quiet"
      | "needs-approval"
      | "failed"
      | "uncertain"
      | "paused-unread";
    readonly runId: string;
  };
  readonly consecutiveUnread: number;
  readonly spendGuard: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly feedback?: { readonly useful: number; readonly notUseful: number };
}

export type DotScheduledPromptAction = "run" | "pause" | "resume" | "delete";

/** A Run now response acknowledges a durable run, which may still be queued. */
export interface DotScheduledPromptRunResponse {
  readonly ok: true;
  readonly runId: string;
  readonly threadId: string;
  readonly status:
    | "queued"
    | "running"
    | "waiting-approval"
    | "completed"
    | "failed"
    | "uncertain"
    | "cancelled";
  readonly duplicate: boolean;
}
