import type { DotCapability, DotMicrosoftState } from "./dotDiscovery";
import type { DotHandlingItem, DotHandlingStopResult, DotHandlingView } from "./dotHandling";
import type { DotScheduledPrompt, DotScheduledPromptAction, DotWatch } from "./dotRoutines";

export interface DotSession {
  readonly ownerToken: string;
  readonly expiresAt: number;
  readonly email: string;
}

export interface DotRun {
  readonly runId: string;
  readonly threadId: string;
  readonly event: { readonly kind: string; readonly text?: string; readonly phase?: string };
  readonly status:
    | "queued"
    | "running"
    | "waiting-approval"
    | "completed"
    | "failed"
    | "uncertain"
    | "cancelled";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: { readonly summary: string; readonly taskId?: string };
  readonly error?: string;
  /** Fixed service-authored status; absent from older services and terminal runs. */
  readonly activity?: {
    readonly kind: string;
    readonly phrase: string;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly step: number;
  };
  readonly activityFresh?: boolean;
}

export function isPendingDotRun(run: DotRun): boolean {
  return ["queued", "running", "waiting-approval"].includes(run.status);
}

export interface DotTask {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: string;
  readonly detail?: { readonly channel?: string; readonly text?: string };
}

export interface DotApproval {
  readonly approvalId: string;
  readonly summary: string;
  readonly action: string;
  readonly payload: Record<string, unknown>;
}

export interface DotMemory {
  readonly memoryId: string;
  readonly version: number;
  readonly text: string;
  readonly status: "active" | "completed";
  readonly remindAt?: string;
}

export type DotFeedbackRating = "useful" | "not-useful";
export type DotFeedbackReason =
  | "already-handled"
  | "not-important"
  | "inaccurate"
  | "too-late"
  | "duplicate";

export const DOT_FEEDBACK_REASONS: ReadonlyArray<{
  readonly id: DotFeedbackReason;
  readonly label: string;
}> = [
  { id: "already-handled", label: "Already handled" },
  { id: "not-important", label: "Not important" },
  { id: "inaccurate", label: "Wrong/inaccurate" },
  { id: "too-late", label: "Too late" },
  { id: "duplicate", label: "Duplicate" },
];

/** One proactive output's owner rating, from `GET /state`. Older bots omit it. */
export interface DotFeedback {
  readonly outputId: string;
  readonly kind: string;
  readonly rating?: DotFeedbackRating;
  readonly reasons?: readonly DotFeedbackReason[];
  readonly note?: string;
  readonly implicit?: "handled" | "not-urgent" | "snoozed";
}

export interface DotQualityCounts {
  readonly kind: string;
  readonly delivered: number;
  readonly rated: number;
  readonly useful: number;
  readonly notUseful: number;
  /** Null until at least one explicit rating exists. */
  readonly usefulRate: number | null;
}

export interface DotQuality {
  readonly windows: ReadonlyArray<{
    readonly days: number;
    readonly total: DotQualityCounts;
    readonly byKind: readonly DotQualityCounts[];
  }>;
}

const PROACTIVE_KINDS = new Set([
  "attention",
  "meeting-prep",
  "heartbeat",
  "routine",
  "harness-update",
]);

/** Mirrors the bot's rule: only finished output the bot sent without being asked can be rated. */
export function isRateableRun(run: DotRun): boolean {
  if (!PROACTIVE_KINDS.has(run.event.kind)) return false;
  if (!["completed", "failed", "uncertain"].includes(run.status)) return false;
  if (run.status === "completed" && !run.result?.summary?.trim()) return false;
  return (
    run.event.kind !== "harness-update" ||
    ["completed", "failed", "uncertain"].includes(run.event.phase ?? "")
  );
}

export interface DotState {
  readonly streamId?: string;
  readonly dotMemory?: readonly DotMemory[];
  readonly user: {
    readonly userId: string;
    readonly email: string;
    readonly paused?: boolean;
    readonly controlVersion?: number;
  };
  readonly tasks: readonly DotTask[];
  readonly runs: readonly DotRun[];
  readonly approvals: readonly DotApproval[];
  readonly feedback?: readonly DotFeedback[];
  readonly quality?: DotQuality;
  /** Absent from older bots; `available: false` means Outlook and calendar are off for this account. */
  readonly microsoft?: DotMicrosoftState;
  readonly handling?: DotHandlingView;
  readonly watches?: readonly DotWatch[];
  readonly scheduledPrompts?: readonly DotScheduledPrompt[];
  readonly capabilities?: readonly DotCapability[];
  readonly capabilitiesError?: string;
}

export interface PendingConnection {
  readonly requestId: string;
  readonly codeVerifier: string;
  readonly expiresAt: number;
  readonly verificationUrl: string;
  readonly userCode: string;
  /** Desktop loopback address that receives the bot's one-time return code. */
  readonly redirectUri?: string;
}

export interface PendingMessage {
  readonly requestId: string;
  readonly threadId: string;
  readonly text: string;
}

export class DotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function readDotSession(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  baseUrl: string,
): DotSession | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(`dot-session:${baseUrl}`) ?? "null");
    if (
      typeof value !== "object" ||
      value === null ||
      !("ownerToken" in value) ||
      !("expiresAt" in value) ||
      !("email" in value)
    )
      return null;
    if (
      typeof value.ownerToken !== "string" ||
      typeof value.expiresAt !== "number" ||
      typeof value.email !== "string" ||
      value.expiresAt <= Date.now() / 1000
    )
      return null;
    return { ownerToken: value.ownerToken, expiresAt: value.expiresAt, email: value.email };
  } catch {
    return null;
  }
}

export function saveDotSession(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  baseUrl: string,
  session: DotSession | null,
): void {
  if (session) storage.setItem(`dot-session:${baseUrl}`, JSON.stringify(session));
  else storage.removeItem(`dot-session:${baseUrl}`);
}

export class DotClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private async request<T>(path: string, session: DotSession | null, body?: unknown): Promise<T> {
    if (session && session.expiresAt <= Date.now() / 1000)
      throw new DotApiError("Sign in again to continue.", 401);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(session ? { Authorization: `Bearer ${session.ownerToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      credentials: "omit",
    });
    // A proxy or gateway error page is not JSON; report it as an unreachable bot.
    const payload = (await response.json().catch(() => ({}))) as T & {
      ok?: boolean;
      error?: string;
      message?: string;
    };
    if (!response.ok || payload.ok !== true)
      throw new DotApiError(
        payload.error ?? payload.message ?? `Could not reach your bot (${response.status}).`,
        response.status,
      );
    return payload;
  }

  async startConnection(redirectUri?: string): Promise<PendingConnection> {
    const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
    const codeChallenge = base64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))),
    );
    const response = await this.request<Omit<PendingConnection, "codeVerifier">>(
      "/client/connect/start",
      null,
      redirectUri ? { codeChallenge, redirectUri } : { codeChallenge },
    );
    if (new URL(response.verificationUrl).origin !== new URL(this.baseUrl).origin)
      throw new Error("The sign-in address does not match your bot.");
    // Older bots ignore the redirect and expect browser confirmation instead.
    const { redirectUri: accepted, ...pending } = response;
    return accepted && accepted === redirectUri
      ? { ...pending, codeVerifier, redirectUri }
      : { ...pending, codeVerifier };
  }

  async pollConnection(
    connection: PendingConnection,
    returnCode?: string,
  ): Promise<DotSession | null> {
    if (connection.expiresAt <= Date.now() / 1000)
      throw new Error("Sign-in expired. Please try again.");
    const response = await this.request<DotSession & { pending?: boolean }>(
      "/client/connect/token",
      null,
      {
        requestId: connection.requestId,
        codeVerifier: connection.codeVerifier,
        ...(returnCode ? { returnCode } : {}),
      },
    );
    return response.pending
      ? null
      : { ownerToken: response.ownerToken, expiresAt: response.expiresAt, email: response.email };
  }

  state(session: DotSession): Promise<DotState> {
    return this.request<DotState>("/state", session);
  }

  /** Poll active runs, including a newly accepted message not yet listed in /state. */
  async stateWithRunDetails(
    session: DotSession,
    acceptedRunIds: readonly string[] = [],
  ): Promise<DotState> {
    const state = await this.state(session);
    const ids = new Set([
      ...state.runs.filter(isPendingDotRun).map((run) => run.runId),
      ...acceptedRunIds.filter(
        (id) => !state.runs.some((run) => run.runId === id && !isPendingDotRun(run)),
      ),
    ]);
    const details = await Promise.all(
      [...ids].map(async (id) => {
        try {
          const { run } = await this.run(session, id);
          return run.runId === id ? run : undefined;
        } catch (cause) {
          if (cause instanceof DotApiError && cause.status === 401) throw cause;
          // The state snapshot still supplies durable approval/result information.
          const snapshot = state.runs.find((run) => run.runId === id);
          return snapshot ? { ...snapshot, activityFresh: false } : undefined;
        }
      }),
    );
    const byId = new Map(state.runs.map((run) => [run.runId, run]));
    for (const run of details) if (run) byId.set(run.runId, run);
    return { ...state, runs: [...byId.values()] };
  }

  send(
    session: DotSession,
    message: PendingMessage,
  ): Promise<{ runId: string; status: DotRun["status"] }> {
    return this.request("/message", session, message);
  }

  run(session: DotSession, runId: string): Promise<{ run: DotRun }> {
    return this.request(`/runs/${encodeURIComponent(runId)}`, session);
  }

  changeMemory(
    session: DotSession,
    memory: DotMemory,
    action: "complete" | "forget",
  ): Promise<{ ok: boolean }> {
    return this.request("/dot-memory", session, {
      action,
      memoryId: memory.memoryId,
      expectedVersion: memory.version,
    });
  }

  pause(
    session: DotSession,
    paused: boolean,
    expectedControlVersion?: number,
  ): Promise<{ paused: boolean; controlVersion?: number; summary?: string }> {
    return this.request(
      paused ? "/pause" : "/resume",
      session,
      expectedControlVersion === undefined ? {} : { expectedControlVersion },
    );
  }

  markHandlingSeen(session: DotSession, through: string): Promise<{ ok: boolean; seenAt: string }> {
    return this.request("/handling/seen", session, { through });
  }

  stopHandling(session: DotSession, item: DotHandlingItem): Promise<DotHandlingStopResult> {
    return this.request(
      `/handling/${encodeURIComponent(item.kind)}/${encodeURIComponent(item.id)}/stop`,
      session,
      { expectedVersion: item.version },
    );
  }

  scheduledPromptAction(
    session: DotSession,
    promptId: string,
    action: DotScheduledPromptAction,
    requestId?: string,
  ): Promise<{
    ok: boolean;
    runId?: string;
    threadId?: string;
    status?: DotRun["status"];
    prompt?: DotScheduledPrompt;
  }> {
    if (action === "run" && !requestId)
      throw new Error("A request ID is required to run a routine.");
    return this.request(
      `/scheduled-prompts/${encodeURIComponent(promptId)}/${action}`,
      session,
      action === "run" ? { requestId } : {},
    );
  }

  rate(
    session: DotSession,
    runId: string,
    rating: DotFeedbackRating,
    reasons: readonly DotFeedbackReason[] = [],
  ): Promise<{ feedback: DotFeedback; changed: boolean }> {
    return this.request(`/feedback/${encodeURIComponent(runId)}`, session, {
      rating,
      ...(rating === "not-useful" && reasons.length ? { reasons } : {}),
    });
  }

  decide(session: DotSession, approvalId: string, approved: boolean): Promise<{ ok: boolean }> {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}`, session, { approved });
  }

  /** Revokes this desktop session on the bot, so a copied token stops working too. Microsoft stays connected. */
  signOut(session: DotSession): Promise<{ ok: boolean }> {
    return this.request("/logout", session, {});
  }
}

/** Keeps only what was typed after a message was sent; an edit to the sent text is kept whole. */
export function draftAfterSend(current: string, sent: string): string {
  return current.startsWith(sent) ? current.slice(sent.length).trimStart() : current;
}

export function runStatusLabel(status: DotRun["status"]): string {
  return {
    queued: "Queued",
    running: "Working…",
    "waiting-approval": "Waiting for your approval",
    completed: "Completed",
    failed: "Failed",
    uncertain: "Interrupted — check the result before retrying",
    cancelled: "Cancelled",
  }[status];
}
