import type { DotRoutineInput } from "./BotRoutineEditor";
import type {
  DotAttachment,
  DotHeldReply,
  DotReplyRouting,
  DotResponsibility,
  DotStructuredResult,
  DotMemoryInput,
  DotResponsibilityInput,
} from "./dotEnhancements";
import type { DotCapability, DotMicrosoftState } from "./dotDiscovery";
import type { DotHandlingItem, DotHandlingStopResult, DotHandlingView } from "./dotHandling";
import type { DotScheduledPrompt, DotScheduledPromptAction, DotWatch } from "./dotRoutines";
import type {
  DotFileRecipe,
  DotFileRecipeAction,
  DotFileRecipeInput,
  DotRecipeFolderListing,
} from "./dotFileRecipes";

export interface DotSession {
  readonly ownerToken: string;
  readonly expiresAt: number;
  readonly email: string;
}

export interface DotRun {
  readonly runId: string;
  readonly threadId: string;
  readonly event: {
    readonly kind: string;
    readonly text?: string;
    readonly phase?: string;
    readonly attachmentIds?: readonly string[];
    readonly attachments?: readonly DotAttachment[];
  };
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
  readonly result?: {
    readonly summary: string;
    readonly taskId?: string;
    /** Only the fields this client reads; services may send more. */
    readonly detail?: { readonly replyHeld?: DotHeldReply };
  };
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
  readonly detail?: { readonly kind?: string; readonly channel?: string; readonly text?: string };
  readonly structuredResult?: DotStructuredResult;
}

export interface DotApproval {
  readonly approvalId: string;
  readonly status?: string;
  readonly summary: string;
  readonly action: string;
  readonly payload: Record<string, unknown>;
  /** Why an assignment drafted from a responsibility reply can no longer start; it can only be declined. */
  readonly notStartable?: string;
}

export interface DotMemory {
  readonly memoryId: string;
  readonly version: number;
  readonly text: string;
  readonly status: "active" | "completed";
  readonly remindAt?: string;
  readonly kind?: "fact" | "preference" | "instruction";
  readonly scope?: "owner";
  readonly provenance?: {
    readonly source: "owner" | "model" | "alert" | "email-follow-up";
    readonly dataOnly: true;
    readonly observations: readonly string[];
  };
  readonly sourceRunId?: string;
  readonly ownerReviewedAt?: string;
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

/** The one computer that runs approved Harness tasks. Any signed-in Harness can chat. */
export interface DotTaskComputer {
  readonly deviceId?: string;
  readonly deviceName: string;
  readonly platform?: string;
  readonly pairedAt: string;
  readonly lastSeenAt?: string;
  readonly online: boolean;
}

export interface DotState {
  readonly streamId?: string;
  readonly enhancements?: Partial<
    Readonly<
      Record<
        | "decisionInbox"
        | "resultCards"
        | "routineEditor"
        | "responsibilities"
        | "replyContinuation"
        | "attachments"
        | "memoryCorrection"
        | "fileRecipes",
        boolean
      >
    >
  >;
  readonly responsibilities?: readonly DotResponsibility[];
  readonly dotMemory?: readonly DotMemory[];
  readonly user: {
    readonly userId: string;
    readonly email: string;
    readonly paused?: boolean;
    readonly controlVersion?: number;
    readonly warnWhenTaskComputerOffline?: boolean;
  };
  readonly taskComputer?: DotTaskComputer | null;
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
  /** Absent from bots without file recipes. */
  readonly fileRecipes?: readonly DotFileRecipe[];
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
  readonly attachmentIds?: readonly string[];
  /** Sent only to services that advertise reply continuation. */
  readonly responsibilityId?: string;
}

/**
 * Why approved Harness work would wait, shown on reviews when the owner wants it.
 * Matches the bot's own notice so Harness and Teams say the same thing.
 */
export function taskComputerNotice(state: DotState): string | null {
  if (state.user.warnWhenTaskComputerOffline === false || state.taskComputer === undefined)
    return null;
  if (state.taskComputer === null)
    return "No computer is set to run Harness tasks, so approved work will wait. Choose Allow in TritonAI Bot settings on the computer that should run it.";
  if (!state.taskComputer.online)
    return `${state.taskComputer.deviceName} is offline, so approved work will wait until it checks in.`;
  return null;
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
  ): Promise<{ runId: string; status: DotRun["status"]; reply?: DotReplyRouting }> {
    return this.request("/message", session, message);
  }

  task(session: DotSession, taskId: string): Promise<{ task: DotTask }> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}`, session);
  }

  approval(session: DotSession, approvalId: string): Promise<{ approval: DotApproval }> {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}`, session);
  }

  readEditableMemory(session: DotSession, memoryId: string): Promise<{ memory: DotMemory }> {
    return this.request(`/owner-memory/${encodeURIComponent(memoryId)}`, session);
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

  saveRoutine(
    session: DotSession,
    input: DotRoutineInput,
    requestId: string,
    prompt?: DotScheduledPrompt,
  ): Promise<{ prompt: DotScheduledPrompt }> {
    return this.request(
      prompt
        ? `/scheduled-prompts/${encodeURIComponent(prompt.promptId)}/edit`
        : "/scheduled-prompts",
      session,
      {
        ...input,
        ...(prompt ? { expectedVersion: prompt.version } : { requestId }),
      },
    );
  }

  previewRoutine(
    session: DotSession,
    input: Pick<DotRoutineInput, "schedule" | "timezone">,
  ): Promise<{ scheduleText: string; nextRunAt?: string }> {
    return this.request("/scheduled-prompts/preview", session, input);
  }

  /** One OneDrive folder level for choosing a recipe folder; omit the ID for the drive root. */
  recipeFolders(session: DotSession, folderId?: string): Promise<DotRecipeFolderListing> {
    return this.request(
      `/file-recipes/folders${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ""}`,
      session,
    );
  }

  /** The request ID makes a retried create return the same recipe. */
  createFileRecipe(
    session: DotSession,
    input: DotFileRecipeInput & { readonly folderId: string },
    requestId: string,
  ): Promise<{ recipe: DotFileRecipe }> {
    return this.request("/file-recipes", session, { ...input, requestId });
  }

  editFileRecipe(
    session: DotSession,
    recipe: DotFileRecipe,
    input: DotFileRecipeInput,
  ): Promise<{ recipe: DotFileRecipe }> {
    return this.request(`/file-recipes/${encodeURIComponent(recipe.recipeId)}/edit`, session, {
      ...input,
      expectedGeneration: recipe.generation,
    });
  }

  fileRecipeAction(
    session: DotSession,
    recipe: DotFileRecipe,
    action: DotFileRecipeAction,
  ): Promise<{ recipe: DotFileRecipe }> {
    return this.request(`/file-recipes/${encodeURIComponent(recipe.recipeId)}/${action}`, session, {
      expectedGeneration: recipe.generation,
    });
  }

  /** The owner's explicit start for one file that did not start on its own. */
  startFileRecipeEvent(
    session: DotSession,
    recipeId: string,
    eventKey: string,
  ): Promise<{ recipe: DotFileRecipe; runId: string; status: DotRun["status"] }> {
    return this.request(
      `/file-recipes/${encodeURIComponent(recipeId)}/events/${encodeURIComponent(eventKey)}/start`,
      session,
      {},
    );
  }

  responsibility(
    session: DotSession,
    input: DotResponsibilityInput,
  ): Promise<{ responsibility: DotResponsibility }> {
    return this.request("/responsibilities", session, input);
  }

  editMemory(session: DotSession, input: DotMemoryInput): Promise<{ memory: DotMemory }> {
    return this.request("/owner-memory", session, input);
  }

  async downloadAttachment(
    session: DotSession,
    attachmentId: string,
  ): Promise<{ name: string; blob: Blob }> {
    const result = await this.request<{ attachment: DotAttachment; dataBase64: string }>(
      `/attachments/${encodeURIComponent(attachmentId)}`,
      session,
    );
    const bytes = Uint8Array.from(atob(result.dataBase64), (character) => character.charCodeAt(0));
    return {
      name: result.attachment.name,
      blob: new Blob([bytes], { type: result.attachment.mimeType }),
    };
  }

  async uploadAttachment(session: DotSession, file: File): Promise<DotAttachment> {
    if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} is larger than 4 MB.`);
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}.`)), {
        once: true,
      });
      reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1] ?? ""), {
        once: true,
      });
      reader.readAsDataURL(file);
    });
    const extensions: Record<string, string> = {
      txt: "text/plain",
      md: "text/markdown",
      csv: "text/csv",
      json: "application/json",
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
    };
    const mimeType = extensions[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? file.type;
    const result = await this.request<{ attachment: DotAttachment }>("/attachments", session, {
      name: file.name,
      mimeType,
      dataBase64,
    });
    return result.attachment;
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

  decide(
    session: DotSession,
    approvalId: string,
    approved: boolean,
  ): Promise<{ ok: boolean; summary?: string }> {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}`, session, { approved });
  }

  updateSettings(
    session: DotSession,
    settings: { readonly warnWhenTaskComputerOffline: boolean },
  ): Promise<{ user: DotState["user"] }> {
    return this.request("/settings", session, settings);
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
