export interface DotSession {
  readonly ownerToken: string;
  readonly expiresAt: number;
  readonly email: string;
}

export interface DotRun {
  readonly runId: string;
  readonly threadId: string;
  readonly event: { readonly kind: string; readonly text?: string };
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

export interface DotState {
  readonly streamId?: string;
  readonly dotMemory?: readonly DotMemory[];
  readonly user: { readonly userId: string; readonly email: string; readonly paused?: boolean };
  readonly tasks: readonly DotTask[];
  readonly runs: readonly DotRun[];
  readonly approvals: readonly DotApproval[];
  /** Absent from older bots; `available: false` means Outlook and calendar are off for this account. */
  readonly microsoft?: { readonly available: boolean; readonly message?: string };
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
    const payload = (await response.json()) as T & { ok?: boolean; error?: string };
    if (!response.ok || payload.ok !== true)
      throw new DotApiError(
        payload.error ?? `Could not reach your bot (${response.status}).`,
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

  pause(session: DotSession, paused: boolean): Promise<{ paused: boolean }> {
    return this.request(paused ? "/pause" : "/resume", session, {});
  }

  decide(session: DotSession, approvalId: string, approved: boolean): Promise<{ ok: boolean }> {
    return this.request(`/approvals/${encodeURIComponent(approvalId)}`, session, { approved });
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
