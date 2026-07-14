// Provider time and random values are deliberately captured at the promise boundary so tests
// can replace fetch while credentials remain behind the injected secret store.
// @effect-diagnostics globalDate:off cryptoRandomUUID:off
import type { IntegrationConnectResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type {
  IntegrationInvocationContext,
  IntegrationProvider,
  IntegrationProviderStatus,
  IntegrationProviderTool,
} from "./IntegrationRegistry.ts";

export const MICROSOFT_GRAPH_CLIENT_ID = "fcfe0e23-a675-4851-99a7-704dfd153b9c";
export const MICROSOFT_GRAPH_TENANT_ID = "8a198873-4fec-4e76-8182-ca479edbbd60";
export const MICROSOFT_GRAPH_SECRET_NAME = "integration-microsoft-365-oauth";

const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN = `https://login.microsoftonline.com/${MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0`;
const BASE_SCOPES = ["User.Read", "offline_access"] as const;
const CAPABILITY_SCOPES: Readonly<Record<string, string>> = {
  "mail.read": "Mail.Read",
  "calendar.read": "Calendars.Read",
};
const REFRESH_TOKEN_FIELD = "refresh_token";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Credential {
  readonly version: 1;
  readonly refreshToken: string;
  readonly grantedScopes: ReadonlyArray<string>;
  readonly accountLabel: string | null;
  readonly updatedAt: string;
}

interface PendingFlow {
  readonly deviceCode: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
  readonly connectionGeneration: number;
  readonly authorizationGeneration: number;
}

interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
}

type Fetch = typeof globalThis.fetch;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Microsoft returned an invalid response.");
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim())
    throw new Error("Microsoft returned an incomplete response.");
  return result;
}

function numberValue(value: Record<string, unknown>, key: string, fallback?: number): number {
  const result = value[key];
  if (typeof result === "number" && Number.isFinite(result)) return result;
  if (fallback !== undefined) return fallback;
  throw new Error("Microsoft returned an incomplete response.");
}

function oauthMessage(value: Record<string, unknown>, status: number): string {
  const description = value.error_description ?? value.error;
  return typeof description === "string" && description.trim()
    ? description.replace(/[\r\n]+/gu, " ").slice(0, 300)
    : `Microsoft identity platform returned HTTP ${status}.`;
}

function isTerminalRefreshError(value: Record<string, unknown>): boolean {
  return value.error === "invalid_grant" || value.error === "interaction_required";
}

function capabilityFromScope(scope: string): string | null {
  const target = scope.toLowerCase();
  return (
    Object.entries(CAPABILITY_SCOPES).find(
      ([, graphScope]) => graphScope.toLowerCase() === target,
    )?.[0] ?? null
  );
}

export const MICROSOFT_GRAPH_TOOLS = [
  {
    name: "microsoft365.mail.search",
    description:
      "Search Microsoft 365 mail using the enabled read-only Mail capability. Accepts an optional query and limit (1-25).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "Optional mail search text." },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Maximum messages." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    openWorld: true,
  },
  {
    name: "microsoft365.calendar.events",
    description:
      "Read Microsoft 365 calendar events in an ISO timestamp range using the enabled read-only Calendar capability.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Inclusive ISO start timestamp." },
        end: { type: "string", description: "Exclusive ISO end timestamp." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    openWorld: true,
  },
] as const satisfies ReadonlyArray<IntegrationProviderTool>;

export class MicrosoftGraphProvider implements IntegrationProvider {
  readonly id = "microsoft-graph";
  readonly tools = MICROSOFT_GRAPH_TOOLS;
  readonly #secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly #fetch: Fetch;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, PendingFlow>();
  #accessToken: AccessToken | null = null;
  #connectionGeneration = 0;
  #authorizationGeneration = 0;
  #disconnecting = false;
  #credentialMutation: Promise<void> = Promise.resolve();

  constructor(
    secrets: ServerSecretStore.ServerSecretStore["Service"],
    fetchImplementation: Fetch = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.#secrets = secrets;
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async #request(
    input: Parameters<Fetch>[0],
    init?: Parameters<Fetch>[1],
    invocationSignal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const signal = invocationSignal
      ? AbortSignal.any([invocationSignal, timeoutSignal])
      : timeoutSignal;
    try {
      return await this.#fetch(input, { ...init, signal });
    } catch (error) {
      if (invocationSignal?.aborted) {
        throw new Error("Microsoft request was cancelled.", { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new Error("Microsoft request timed out.", { cause: error });
      }
      throw error;
    }
  }

  #serializeCredential<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #readCredential(): Promise<Credential | null> {
    const value = await Effect.runPromise(this.#secrets.get(MICROSOFT_GRAPH_SECRET_NAME));
    if (Option.isNone(value)) return null;
    try {
      const parsed = JSON.parse(decoder.decode(value.value)) as Credential;
      if (
        parsed.version !== 1 ||
        typeof parsed.refreshToken !== "string" ||
        !Array.isArray(parsed.grantedScopes)
      ) {
        throw new Error("Invalid credential format.");
      }
      return parsed;
    } catch {
      await Effect.runPromise(this.#secrets.remove(MICROSOFT_GRAPH_SECRET_NAME)).catch(
        () => undefined,
      );
      return null;
    }
  }

  async #writeCredential(credential: Credential): Promise<void> {
    await Effect.runPromise(
      this.#secrets.set(MICROSOFT_GRAPH_SECRET_NAME, encoder.encode(JSON.stringify(credential))),
    );
  }

  async status(): Promise<IntegrationProviderStatus> {
    const credential = await this.#readCredential();
    return {
      state: credential ? "connected" : this.#pending.size ? "connecting" : "not_connected",
      accountLabel: credential?.accountLabel ?? null,
      grantedCapabilities:
        credential?.grantedScopes
          .map(capabilityFromScope)
          .filter((value): value is string => value !== null) ?? [],
      message: credential ? "Connected with read-only delegated access." : null,
    };
  }

  async #postForm(
    path: string,
    form: Record<string, string>,
    invocationSignal?: AbortSignal,
  ): Promise<{ response: Response; json: Record<string, unknown> }> {
    const response = await this.#request(
      `${LOGIN}/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      },
      invocationSignal,
    );
    return { response, json: asRecord(await response.json()) };
  }

  async connect(capabilities: ReadonlyArray<string>): Promise<IntegrationConnectResult> {
    if (this.#disconnecting) throw new Error("Microsoft 365 is disconnecting.");
    const connectionGeneration = this.#connectionGeneration;
    const previousAuthorizationGeneration = this.#authorizationGeneration;
    const requestedScopes = capabilities.map((capability) => CAPABILITY_SCOPES[capability]);
    if (requestedScopes.some((scope) => !scope))
      throw new Error("Unsupported Microsoft 365 capability.");
    const existing = await this.#readCredential();
    const { response, json } = await this.#postForm("devicecode", {
      client_id: MICROSOFT_GRAPH_CLIENT_ID,
      scope: [
        ...new Set([...BASE_SCOPES, ...(existing?.grantedScopes ?? []), ...requestedScopes]),
      ].join(" "),
    });
    if (!response.ok)
      throw new Error(`Microsoft sign-in could not start: ${oauthMessage(json, response.status)}`);
    const deviceCode = requiredString(json, "device_code");
    const verificationUri = requiredString(json, "verification_uri");
    const userCode = requiredString(json, "user_code");
    const intervalSeconds = Math.max(1, Math.floor(numberValue(json, "interval", 5)));
    const expiresAt = Date.now() + numberValue(json, "expires_in") * 1000;
    if (
      this.#disconnecting ||
      connectionGeneration !== this.#connectionGeneration ||
      previousAuthorizationGeneration !== this.#authorizationGeneration
    ) {
      throw new Error("Microsoft 365 sign-in was superseded while starting.");
    }
    const authorizationGeneration = previousAuthorizationGeneration + 1;
    this.#authorizationGeneration = authorizationGeneration;
    this.#pending.clear();
    const flowId = crypto.randomUUID();
    this.#pending.set(flowId, {
      deviceCode,
      capabilities: [...capabilities],
      intervalSeconds,
      expiresAt,
      connectionGeneration,
      authorizationGeneration,
    });
    return {
      flowId,
      verificationUri,
      verificationUriComplete:
        typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : null,
      userCode,
      message:
        typeof json.message === "string"
          ? json.message
          : `Open ${verificationUri} and enter ${userCode}.`,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds,
    };
  }

  async poll(flowId: string) {
    const flow = this.#pending.get(flowId);
    if (!flow) throw new Error("Microsoft sign-in flow was not found.");
    if (flow.expiresAt <= Date.now()) {
      this.#pending.delete(flowId);
      return {
        state: "expired" as const,
        retryAfterSeconds: null,
        message: "Sign-in expired. Start again.",
      };
    }
    const { response, json } = await this.#postForm("token", {
      client_id: MICROSOFT_GRAPH_CLIENT_ID,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: flow.deviceCode,
    });
    if (
      flow.connectionGeneration !== this.#connectionGeneration ||
      flow.authorizationGeneration !== this.#authorizationGeneration ||
      !this.#pending.has(flowId)
    ) {
      throw new Error("Microsoft sign-in flow was superseded.");
    }
    if (!response.ok) {
      if (json.error === "authorization_pending") {
        return {
          state: "pending" as const,
          retryAfterSeconds: flow.intervalSeconds,
          message: "Waiting for Microsoft sign-in.",
        };
      }
      if (json.error === "slow_down") {
        const retryAfterSeconds = flow.intervalSeconds + 5;
        this.#pending.set(flowId, { ...flow, intervalSeconds: retryAfterSeconds });
        return {
          state: "pending" as const,
          retryAfterSeconds,
          message: "Microsoft asked us to poll more slowly.",
        };
      }
      this.#pending.delete(flowId);
      return {
        state: "failed" as const,
        retryAfterSeconds: null,
        message: `Sign-in failed: ${oauthMessage(json, response.status)}`,
      };
    }
    const accessToken = requiredString(json, "access_token");
    const refreshToken = requiredString(json, "refresh_token");
    const scopes = requiredString(json, "scope").split(/\s+/u).filter(Boolean);
    await this.#serializeCredential(async () => {
      if (
        this.#disconnecting ||
        flow.connectionGeneration !== this.#connectionGeneration ||
        flow.authorizationGeneration !== this.#authorizationGeneration ||
        !this.#pending.has(flowId)
      ) {
        throw new Error("Microsoft 365 was disconnected before sign-in completed.");
      }
      await this.#writeCredential({
        version: 1,
        refreshToken,
        grantedScopes: scopes,
        accountLabel: null,
        updatedAt: new Date().toISOString(),
      });
      this.#accessToken = {
        value: accessToken,
        expiresAt: Date.now() + numberValue(json, "expires_in") * 1000,
      };
    });
    let accountLabel: string | null = null;
    try {
      const accountResponse = await this.#request(
        `${GRAPH}/me?$select=displayName,mail,userPrincipalName`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
        },
      );
      if (accountResponse.ok) {
        const account = asRecord(await accountResponse.json());
        accountLabel =
          [account.displayName, account.mail ?? account.userPrincipalName]
            .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
            .join(" · ") || null;
      }
    } catch {
      // Profile data is optional enrichment. The already-issued refresh credential remains the
      // source of truth so a transient Graph failure cannot consume a one-time device code.
    }
    if (accountLabel) {
      await this.#serializeCredential(async () => {
        if (
          this.#disconnecting ||
          flow.connectionGeneration !== this.#connectionGeneration ||
          flow.authorizationGeneration !== this.#authorizationGeneration ||
          !this.#pending.has(flowId)
        ) {
          throw new Error("Microsoft 365 was disconnected before sign-in completed.");
        }
        await this.#writeCredential({
          version: 1,
          refreshToken,
          grantedScopes: scopes,
          accountLabel,
          updatedAt: new Date().toISOString(),
        });
      });
    }
    if (
      this.#disconnecting ||
      flow.connectionGeneration !== this.#connectionGeneration ||
      flow.authorizationGeneration !== this.#authorizationGeneration ||
      !this.#pending.has(flowId)
    ) {
      throw new Error("Microsoft 365 was disconnected before sign-in completed.");
    }
    this.#pending.delete(flowId);
    return {
      state: "connected" as const,
      retryAfterSeconds: null,
      message: "Microsoft 365 is connected.",
    };
  }

  disconnect(): Promise<void> {
    return this.#serializeCredential(async () => {
      this.#disconnecting = true;
      this.#connectionGeneration += 1;
      this.#authorizationGeneration += 1;
      this.#accessToken = null;
      this.#pending.clear();
      try {
        await Effect.runPromise(this.#secrets.remove(MICROSOFT_GRAPH_SECRET_NAME));
      } finally {
        this.#disconnecting = false;
      }
    });
  }

  #token(invocationSignal?: AbortSignal): Promise<string> {
    return this.#serializeCredential(async () => {
      if (invocationSignal?.aborted) throw new Error("Microsoft request was cancelled.");
      if (this.#disconnecting) throw new Error("Microsoft 365 is disconnecting.");
      const connectionGeneration = this.#connectionGeneration;
      if (this.#accessToken && this.#accessToken.expiresAt - 300_000 > Date.now()) {
        return this.#accessToken.value;
      }
      const credential = await this.#readCredential();
      if (this.#disconnecting || connectionGeneration !== this.#connectionGeneration) {
        throw new Error("Microsoft 365 was disconnected while access was refreshing.");
      }
      if (!credential) throw new Error("Microsoft 365 is not connected.");
      const { response, json } = await this.#postForm(
        "token",
        {
          client_id: MICROSOFT_GRAPH_CLIENT_ID,
          grant_type: REFRESH_TOKEN_FIELD,
          [REFRESH_TOKEN_FIELD]: credential.refreshToken,
          scope: [...BASE_SCOPES, ...credential.grantedScopes].join(" "),
        },
        invocationSignal,
      );
      if (!response.ok) {
        if (isTerminalRefreshError(json)) {
          this.#accessToken = null;
          await Effect.runPromise(this.#secrets.remove(MICROSOFT_GRAPH_SECRET_NAME));
        }
        throw new Error(
          `Microsoft access could not refresh: ${oauthMessage(json, response.status)}`,
        );
      }
      const accessToken = requiredString(json, "access_token");
      const rotatedRefresh = json[REFRESH_TOKEN_FIELD];
      const refreshCredential =
        typeof rotatedRefresh === "string" ? rotatedRefresh : credential.refreshToken;
      const grantedScopes =
        typeof json.scope === "string"
          ? json.scope.split(/\s+/u).filter(Boolean)
          : credential.grantedScopes;
      if (this.#disconnecting || connectionGeneration !== this.#connectionGeneration) {
        throw new Error("Microsoft 365 was disconnected while access was refreshing.");
      }
      await this.#writeCredential({
        ...credential,
        refreshToken: refreshCredential,
        grantedScopes,
        updatedAt: new Date().toISOString(),
      });
      this.#accessToken = {
        value: accessToken,
        expiresAt: Date.now() + numberValue(json, "expires_in") * 1000,
      };
      return accessToken;
    });
  }

  async #graph(path: string, invocationSignal?: AbortSignal): Promise<unknown> {
    const response = await this.#request(
      `${GRAPH}${path}`,
      { headers: { authorization: `Bearer ${await this.#token(invocationSignal)}` } },
      invocationSignal,
    );
    if (!response.ok)
      throw new Error(`Microsoft Graph request failed with HTTP ${response.status}.`);
    return response.json();
  }

  async invoke(
    toolName: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown> {
    const values = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (toolName === "microsoft365.mail.search") {
      const query = typeof values.query === "string" ? values.query.trim().slice(0, 200) : "";
      const top = Math.min(
        25,
        Math.max(1, typeof values.limit === "number" ? Math.floor(values.limit) : 10),
      );
      const params = new URLSearchParams({
        $select: "id,subject,from,receivedDateTime,isRead",
        $top: String(top),
      });
      if (query) params.set("$search", `"${query.replace(/["\\\\]/gu, " ")}"`);
      else params.set("$orderby", "receivedDateTime desc");
      return this.#graph(`/me/messages?${params.toString()}`, context?.signal);
    }
    if (toolName === "microsoft365.calendar.events") {
      const start = typeof values.start === "string" ? values.start : new Date().toISOString();
      const end =
        typeof values.end === "string"
          ? values.end
          : new Date(Date.now() + 7 * 86_400_000).toISOString();
      if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)))
        throw new Error("Calendar start and end must be ISO timestamps.");
      const params = new URLSearchParams({
        startDateTime: start,
        endDateTime: end,
        $select: "id,subject,start,end,location,organizer",
        $top: "50",
        $orderby: "start/dateTime",
      });
      return this.#graph(`/me/calendarView?${params.toString()}`, context?.signal);
    }
    throw new Error("Unsupported Microsoft 365 tool.");
  }
}
