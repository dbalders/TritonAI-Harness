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
      readonly action: "cancel" | "resume";
      readonly responsibilityId: string;
      readonly expectedVersion: number;
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

export function botWebUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
