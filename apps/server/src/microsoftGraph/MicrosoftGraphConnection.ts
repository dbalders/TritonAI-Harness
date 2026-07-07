import {
  MicrosoftGraphAccount as MicrosoftGraphAccountSchema,
  MicrosoftGraphClientId,
  MicrosoftGraphConnectionError,
  MicrosoftGraphRequiredScopes,
  MicrosoftGraphTenantId,
  type MicrosoftGraphAccount,
  type MicrosoftGraphConnectionStatus,
  type MicrosoftGraphDisconnectResult,
  type MicrosoftGraphPollSignInInput,
  type MicrosoftGraphPollSignInResult,
  type MicrosoftGraphStartSignInResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export { MicrosoftGraphClientId, MicrosoftGraphRequiredScopes, MicrosoftGraphTenantId };

export const MICROSOFT_GRAPH_CREDENTIAL_SECRET_NAME = "microsoft-graph-refresh-token-cache";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const GRAPH_BASE_URL = "https://graph.microsoft.com";
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

type HttpMethod = "GET" | "POST";

interface JsonHttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly form?: Readonly<Record<string, string>>;
  readonly json?: unknown;
}

interface JsonHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
}

export interface MicrosoftGraphHttpClientShape {
  readonly requestJson: (
    request: JsonHttpRequest,
  ) => Effect.Effect<JsonHttpResponse, MicrosoftGraphConnectionError>;
}

export class MicrosoftGraphHttpClient extends Context.Service<
  MicrosoftGraphHttpClient,
  MicrosoftGraphHttpClientShape
>()("t3/microsoftGraph/MicrosoftGraphConnection/MicrosoftGraphHttpClient") {}

export interface MicrosoftGraphRequestJsonInput {
  readonly path: `/${string}`;
  readonly method?: "GET";
}

export interface MicrosoftGraphConnectionShape {
  readonly getStatus: () => Effect.Effect<
    MicrosoftGraphConnectionStatus,
    MicrosoftGraphConnectionError
  >;
  readonly startSignIn: () => Effect.Effect<
    MicrosoftGraphStartSignInResult,
    MicrosoftGraphConnectionError
  >;
  readonly pollSignIn: (
    input: MicrosoftGraphPollSignInInput,
  ) => Effect.Effect<MicrosoftGraphPollSignInResult, MicrosoftGraphConnectionError>;
  readonly disconnect: () => Effect.Effect<
    MicrosoftGraphDisconnectResult,
    MicrosoftGraphConnectionError
  >;
  readonly requestGraphJson: (
    input: MicrosoftGraphRequestJsonInput,
  ) => Effect.Effect<unknown, MicrosoftGraphConnectionError>;
}

export class MicrosoftGraphConnection extends Context.Service<
  MicrosoftGraphConnection,
  MicrosoftGraphConnectionShape
>()("t3/microsoftGraph/MicrosoftGraphConnection") {}

const PersistedCredential = Schema.Struct({
  version: Schema.Literal(1),
  clientId: Schema.Literal(MicrosoftGraphClientId),
  tenantId: Schema.Literal(MicrosoftGraphTenantId),
  refreshToken: Schema.String,
  grantedScopes: Schema.Array(Schema.String),
  account: Schema.NullOr(MicrosoftGraphAccountSchema),
  updatedAt: Schema.String,
});
type PersistedCredential = typeof PersistedCredential.Type;

const PersistedCredentialJson = Schema.fromJsonString(PersistedCredential);
const decodePersistedCredentialJson = Schema.decodeUnknownEffect(PersistedCredentialJson);
const encodePersistedCredentialJson = Schema.encodeEffect(PersistedCredentialJson);

interface ActiveAccessToken {
  readonly accessToken: string;
  readonly expiresAtEpochMs: number;
  readonly grantedScopes: ReadonlyArray<string>;
}

interface ParsedTokenResponse extends ActiveAccessToken {
  readonly refreshToken: string;
}

interface PendingDeviceFlow {
  readonly flowId: string;
  readonly deviceCode: string;
  readonly expiresAtEpochMs: number;
  readonly intervalSeconds: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function connectionError(
  code:
    | "not_connected"
    | "flow_not_found"
    | "flow_expired"
    | "oauth_error"
    | "graph_error"
    | "storage_error"
    | "invalid_response",
  message: string,
  cause?: unknown,
) {
  return new MicrosoftGraphConnectionError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function redactConnectionError(
  error: MicrosoftGraphConnectionError,
): MicrosoftGraphConnectionError {
  return new MicrosoftGraphConnectionError({
    code: error.code,
    message: error.message,
  });
}

function exposeConnectionEffect<A, R>(
  effect: Effect.Effect<A, MicrosoftGraphConnectionError, R>,
): Effect.Effect<A, MicrosoftGraphConnectionError, R> {
  return effect.pipe(Effect.mapError(redactConnectionError));
}

function isoFromEpochMs(epochMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMs));
}

function scopeString(): string {
  return MicrosoftGraphRequiredScopes.join(" ");
}

function splitScopes(scope: string | undefined): ReadonlyArray<string> {
  const scopes = scope?.trim().split(/\s+/u).filter(Boolean) ?? [];
  return scopes.length > 0 ? scopes : [...MicrosoftGraphRequiredScopes];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function nullableStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : null;
}

function oauthError(response: JsonHttpResponse): string | undefined {
  return stringField(response.json, "error");
}

function oauthErrorDescription(response: JsonHttpResponse): string {
  return (
    stringField(response.json, "error_description") ??
    stringField(response.json, "error") ??
    `Microsoft identity platform returned HTTP ${response.status}.`
  );
}

function tokenEndpoint(): string {
  return `https://login.microsoftonline.com/${MicrosoftGraphTenantId}/oauth2/v2.0/token`;
}

function deviceCodeEndpoint(): string {
  return `https://login.microsoftonline.com/${MicrosoftGraphTenantId}/oauth2/v2.0/devicecode`;
}

function toStatus(
  credential: PersistedCredential | null,
  activeAccessToken: ActiveAccessToken | null,
): MicrosoftGraphConnectionStatus {
  return {
    state: credential ? "connected" : "not_connected",
    account: credential?.account ?? null,
    clientId: MicrosoftGraphClientId,
    tenantId: MicrosoftGraphTenantId,
    requiredScopes: [...MicrosoftGraphRequiredScopes],
    grantedScopes: credential?.grantedScopes ?? [],
    accessTokenExpiresAt: activeAccessToken
      ? isoFromEpochMs(activeAccessToken.expiresAtEpochMs)
      : null,
    updatedAt: credential?.updatedAt ?? null,
  };
}

function parseDeviceCodeResponse(
  response: JsonHttpResponse,
  flowId: string,
  nowEpochMs: number,
): Effect.Effect<
  {
    readonly pending: PendingDeviceFlow;
    readonly result: MicrosoftGraphStartSignInResult;
  },
  MicrosoftGraphConnectionError
> {
  const deviceCode = stringField(response.json, "device_code");
  const userCode = stringField(response.json, "user_code");
  const verificationUri =
    stringField(response.json, "verification_uri") ??
    stringField(response.json, "verification_url");
  const expiresIn = numberField(response.json, "expires_in");
  const interval = numberField(response.json, "interval") ?? 5;
  const message = stringField(response.json, "message");

  if (!deviceCode || !userCode || !verificationUri || !expiresIn) {
    return Effect.fail(
      connectionError(
        "invalid_response",
        "Microsoft identity platform returned an incomplete device-code response.",
      ),
    );
  }

  const expiresAtEpochMs = nowEpochMs + expiresIn * 1000;
  const intervalSeconds = Math.max(1, Math.floor(interval));
  return Effect.succeed({
    pending: {
      flowId,
      deviceCode,
      expiresAtEpochMs,
      intervalSeconds,
    },
    result: {
      flowId,
      verificationUri,
      verificationUriComplete: stringField(response.json, "verification_uri_complete") ?? null,
      userCode,
      message: message ?? `Open ${verificationUri} and enter code ${userCode}.`,
      expiresAt: isoFromEpochMs(expiresAtEpochMs),
      intervalSeconds,
      clientId: MicrosoftGraphClientId,
      tenantId: MicrosoftGraphTenantId,
      requiredScopes: [...MicrosoftGraphRequiredScopes],
    },
  });
}

function parseTokenResponse(
  response: JsonHttpResponse,
  nowEpochMs: number,
  existing?: PersistedCredential,
): Effect.Effect<ParsedTokenResponse, MicrosoftGraphConnectionError> {
  const accessToken = stringField(response.json, "access_token");
  const refreshToken = stringField(response.json, "refresh_token") ?? existing?.refreshToken;
  const expiresIn = numberField(response.json, "expires_in");

  if (!accessToken || !refreshToken || !expiresIn) {
    return Effect.fail(
      connectionError(
        "invalid_response",
        "Microsoft identity platform returned an incomplete token response.",
      ),
    );
  }

  return Effect.succeed({
    accessToken,
    refreshToken,
    grantedScopes: splitScopes(stringField(response.json, "scope")),
    expiresAtEpochMs: nowEpochMs + expiresIn * 1000,
  });
}

function parseAccount(
  response: JsonHttpResponse,
): Effect.Effect<MicrosoftGraphAccount, MicrosoftGraphConnectionError> {
  if (!response.ok) {
    return Effect.fail(
      connectionError("graph_error", "Microsoft Graph could not read the signed-in profile."),
    );
  }

  return Effect.succeed({
    id: nullableStringField(response.json, "id"),
    displayName: nullableStringField(response.json, "displayName"),
    mail: nullableStringField(response.json, "mail"),
    userPrincipalName: nullableStringField(response.json, "userPrincipalName"),
  });
}

export const httpClientLayerLive = Layer.effect(
  MicrosoftGraphHttpClient,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return MicrosoftGraphHttpClient.of({
      requestJson: (request) =>
        Effect.gen(function* () {
          let httpRequest =
            request.method === "POST"
              ? HttpClientRequest.post(request.url)
              : HttpClientRequest.get(request.url);
          for (const [key, value] of Object.entries(request.headers ?? {})) {
            httpRequest = HttpClientRequest.setHeader(key, value)(httpRequest);
          }
          if (request.form) {
            httpRequest = HttpClientRequest.bodyUrlParams(request.form)(httpRequest);
          } else if (request.json !== undefined) {
            httpRequest = yield* HttpClientRequest.bodyJson(request.json)(httpRequest);
          }
          const response = yield* httpClient.execute(httpRequest);
          const json = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response);
          return {
            status: response.status,
            ok: response.status >= 200 && response.status < 300,
            json,
          };
        }).pipe(
          Effect.mapError((cause) =>
            connectionError("invalid_response", "Microsoft Graph HTTP request failed.", cause),
          ),
        ),
    });
  }),
);

export const make = Effect.fn("makeMicrosoftGraphConnection")(function* () {
  const crypto = yield* Crypto.Crypto;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* MicrosoftGraphHttpClient;
  const pendingFlows = new Map<string, PendingDeviceFlow>();
  let activeAccessToken: ActiveAccessToken | null = null;

  const nowEpochMs = () => Clock.currentTimeMillis;

  const readCredential = Effect.fn("MicrosoftGraphConnection.readCredential")(function* () {
    const bytes = yield* secrets
      .get(MICROSOFT_GRAPH_CREDENTIAL_SECRET_NAME)
      .pipe(
        Effect.mapError((cause) =>
          connectionError("storage_error", "Failed to read Microsoft Graph credential.", cause),
        ),
      );
    if (Option.isNone(bytes)) return null;
    return yield* decodePersistedCredentialJson(textDecoder.decode(bytes.value)).pipe(
      Effect.catch(() =>
        secrets.remove(MICROSOFT_GRAPH_CREDENTIAL_SECRET_NAME).pipe(Effect.ignore, Effect.as(null)),
      ),
    );
  });

  const writeCredential = Effect.fn("MicrosoftGraphConnection.writeCredential")(function* (
    credential: PersistedCredential,
  ) {
    const encoded = yield* encodePersistedCredentialJson(credential).pipe(
      Effect.mapError((cause) =>
        connectionError("storage_error", "Failed to encode Microsoft Graph credential.", cause),
      ),
    );
    yield* secrets
      .set(MICROSOFT_GRAPH_CREDENTIAL_SECRET_NAME, textEncoder.encode(encoded))
      .pipe(
        Effect.mapError((cause) =>
          connectionError("storage_error", "Failed to persist Microsoft Graph credential.", cause),
        ),
      );
  });

  const getStatus = Effect.fn("MicrosoftGraphConnection.getStatus")(function* () {
    return toStatus(yield* readCredential(), activeAccessToken);
  });

  const loadAccount = (accessToken: string) =>
    http
      .requestJson({
        method: "GET",
        url: `${GRAPH_BASE_URL}/v1.0/me?$select=id,displayName,mail,userPrincipalName`,
        headers: { authorization: `Bearer ${accessToken}` },
      })
      .pipe(Effect.flatMap(parseAccount));

  const persistTokenResponse = Effect.fn("MicrosoftGraphConnection.persistTokenResponse")(
    function* (response: JsonHttpResponse, existing?: PersistedCredential) {
      const now = yield* nowEpochMs();
      const token = yield* parseTokenResponse(response, now, existing);
      activeAccessToken = {
        accessToken: token.accessToken,
        expiresAtEpochMs: token.expiresAtEpochMs,
        grantedScopes: token.grantedScopes,
      };
      const account = existing?.account ?? (yield* loadAccount(token.accessToken));
      const credential: PersistedCredential = {
        version: 1,
        clientId: MicrosoftGraphClientId,
        tenantId: MicrosoftGraphTenantId,
        refreshToken: token.refreshToken,
        grantedScopes: [...token.grantedScopes],
        account,
        updatedAt: isoFromEpochMs(now),
      };
      yield* writeCredential(credential);
      return credential;
    },
  );

  const refreshAccessToken = Effect.fn("MicrosoftGraphConnection.refreshAccessToken")(function* (
    credential: PersistedCredential,
  ) {
    const response = yield* http.requestJson({
      method: "POST",
      url: tokenEndpoint(),
      form: {
        client_id: MicrosoftGraphClientId,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        scope: scopeString(),
      },
    });

    if (!response.ok) {
      return yield* connectionError(
        "oauth_error",
        `Microsoft identity platform could not refresh Graph access: ${oauthErrorDescription(
          response,
        )}`,
      );
    }

    return yield* persistTokenResponse(response, credential);
  });

  const ensureAccessToken = Effect.fn("MicrosoftGraphConnection.ensureAccessToken")(function* () {
    const credential = yield* readCredential();
    if (!credential) {
      return yield* connectionError(
        "not_connected",
        "Microsoft Graph is not connected. Sign in from Settings -> Connections first.",
      );
    }
    const now = yield* nowEpochMs();
    if (
      activeAccessToken !== null &&
      activeAccessToken.expiresAtEpochMs - ACCESS_TOKEN_REFRESH_SKEW_MS > now
    ) {
      return activeAccessToken.accessToken;
    }
    yield* refreshAccessToken(credential);
    if (activeAccessToken === null) {
      return yield* connectionError("oauth_error", "Microsoft Graph access token refresh failed.");
    }
    return activeAccessToken.accessToken;
  });

  const startSignIn = Effect.fn("MicrosoftGraphConnection.startSignIn")(function* () {
    const [flowId, now] = yield* Effect.all([
      crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          connectionError(
            "invalid_response",
            "Failed to create Microsoft Graph sign-in flow.",
            cause,
          ),
        ),
      ),
      nowEpochMs(),
    ]);
    const response = yield* http.requestJson({
      method: "POST",
      url: deviceCodeEndpoint(),
      form: {
        client_id: MicrosoftGraphClientId,
        scope: scopeString(),
      },
    });

    if (!response.ok) {
      return yield* connectionError(
        "oauth_error",
        `Microsoft identity platform could not start Graph sign-in: ${oauthErrorDescription(
          response,
        )}`,
      );
    }

    const parsed = yield* parseDeviceCodeResponse(response, flowId, now);
    pendingFlows.set(flowId, parsed.pending);
    return parsed.result;
  });

  const pollSignIn = Effect.fn("MicrosoftGraphConnection.pollSignIn")(function* (
    input: MicrosoftGraphPollSignInInput,
  ) {
    const flow = pendingFlows.get(input.flowId);
    if (!flow) {
      return yield* connectionError(
        "flow_not_found",
        "Microsoft Graph sign-in flow was not found.",
      );
    }

    const now = yield* nowEpochMs();
    if (flow.expiresAtEpochMs <= now) {
      pendingFlows.delete(input.flowId);
      return {
        state: "expired",
        status: yield* getStatus(),
        retryAfterSeconds: null,
        message: "Microsoft Graph sign-in expired. Start a new sign-in flow.",
      } satisfies MicrosoftGraphPollSignInResult;
    }

    const response = yield* http.requestJson({
      method: "POST",
      url: tokenEndpoint(),
      form: {
        client_id: MicrosoftGraphClientId,
        grant_type: DEVICE_CODE_GRANT,
        device_code: flow.deviceCode,
      },
    });

    if (!response.ok) {
      const error = oauthError(response);
      if (error === "authorization_pending") {
        return {
          state: "pending",
          status: yield* getStatus(),
          retryAfterSeconds: flow.intervalSeconds,
          message: "Waiting for Microsoft sign-in to finish.",
        } satisfies MicrosoftGraphPollSignInResult;
      }
      if (error === "slow_down") {
        const retryAfterSeconds = flow.intervalSeconds + 5;
        pendingFlows.set(input.flowId, { ...flow, intervalSeconds: retryAfterSeconds });
        return {
          state: "pending",
          status: yield* getStatus(),
          retryAfterSeconds,
          message: "Microsoft asked us to slow down sign-in polling.",
        } satisfies MicrosoftGraphPollSignInResult;
      }
      if (error === "expired_token") {
        pendingFlows.delete(input.flowId);
        return {
          state: "expired",
          status: yield* getStatus(),
          retryAfterSeconds: null,
          message: "Microsoft Graph sign-in expired. Start a new sign-in flow.",
        } satisfies MicrosoftGraphPollSignInResult;
      }
      if (error === "authorization_declined" || error === "bad_verification_code") {
        pendingFlows.delete(input.flowId);
        return {
          state: "failed",
          status: yield* getStatus(),
          retryAfterSeconds: null,
          message:
            error === "authorization_declined"
              ? "Microsoft Graph sign-in was declined."
              : "Microsoft Graph sign-in code was rejected. Start a new sign-in flow.",
        } satisfies MicrosoftGraphPollSignInResult;
      }

      return yield* connectionError(
        "oauth_error",
        `Microsoft identity platform could not finish Graph sign-in: ${oauthErrorDescription(
          response,
        )}`,
      );
    }

    const credential = yield* persistTokenResponse(response);
    pendingFlows.delete(input.flowId);
    return {
      state: "connected",
      status: toStatus(credential, activeAccessToken),
      retryAfterSeconds: null,
      message: "Microsoft Graph is connected.",
    } satisfies MicrosoftGraphPollSignInResult;
  });

  const disconnect = Effect.fn("MicrosoftGraphConnection.disconnect")(function* () {
    yield* secrets
      .remove(MICROSOFT_GRAPH_CREDENTIAL_SECRET_NAME)
      .pipe(
        Effect.mapError((cause) =>
          connectionError("storage_error", "Failed to remove Microsoft Graph credential.", cause),
        ),
      );
    activeAccessToken = null;
    pendingFlows.clear();
    return {
      status: toStatus(null, null),
    } satisfies MicrosoftGraphDisconnectResult;
  });

  const requestGraphJson = Effect.fn("MicrosoftGraphConnection.requestGraphJson")(function* (
    input: MicrosoftGraphRequestJsonInput,
  ) {
    if (!input.path.startsWith("/") || input.path.startsWith("//")) {
      return yield* connectionError("graph_error", "Graph requests must use root-relative paths.");
    }
    const url = new URL(input.path, `${GRAPH_BASE_URL}/`);
    if (url.origin !== GRAPH_BASE_URL) {
      return yield* connectionError("graph_error", "Graph requests must target Microsoft Graph.");
    }

    const accessToken = yield* ensureAccessToken();
    const response = yield* http.requestJson({
      method: input.method ?? "GET",
      url: url.toString(),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      return yield* connectionError(
        "graph_error",
        `Microsoft Graph request failed with HTTP ${response.status}.`,
      );
    }
    return response.json;
  });

  return MicrosoftGraphConnection.of({
    getStatus: () => exposeConnectionEffect(getStatus()),
    startSignIn: () => exposeConnectionEffect(startSignIn()),
    pollSignIn: (input) => exposeConnectionEffect(pollSignIn(input)),
    disconnect: () => exposeConnectionEffect(disconnect()),
    requestGraphJson: (input) => exposeConnectionEffect(requestGraphJson(input)),
  });
});

export const layer = Layer.effect(MicrosoftGraphConnection, make());

export const layerLive = layer.pipe(Layer.provide(httpClientLayerLive));
