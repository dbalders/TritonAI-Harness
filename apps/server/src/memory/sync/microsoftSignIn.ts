/**
 * The Microsoft sign-in memory sync uses to reach the user's OneDrive.
 *
 * It uses the same Entra app as the Microsoft 365 plugin. When that plugin is
 * already connected, its saved sign-in is exchanged for OneDrive access
 * without asking the user again; otherwise the user signs in once with a
 * device code. Memory sync then keeps its own credential, so disconnecting the
 * plugin does not stop sync and signing out of sync does not disconnect the
 * plugin.
 */
// @effect-diagnostics nodeBuiltinImport:off - A device code's hash names its sign-in flow.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

declare const __TRITONAI_BUILD_MICROSOFT_OAUTH__: unknown;

const OWN_SECRET = "memory-sync-microsoft";
// The Microsoft 365 plugin's credential, in the integration secret namespace.
const PLUGIN_SECRET = "integration-microsoft-365--oauth";
const SCOPES = "Files.ReadWrite User.Read offline_access";
const REQUEST_TIMEOUT = Duration.seconds(20);
const ACCESS_TOKEN_SKEW_MS = 60_000;
const ENTRA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface MicrosoftOAuthConfig {
  readonly clientId: string;
  readonly tenantId: string;
}

function parseOAuthJson(raw: string | undefined): unknown {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * The Entra app built into this release, or null when the build has none. A
 * server run from source reads the same `TRITONAI_MICROSOFT_OAUTH_JSON` the
 * build does.
 */
function builtMicrosoftOAuthConfig(): MicrosoftOAuthConfig | null {
  const value: unknown =
    typeof __TRITONAI_BUILD_MICROSOFT_OAUTH__ === "undefined"
      ? parseOAuthJson(process.env.TRITONAI_MICROSOFT_OAUTH_JSON)
      : __TRITONAI_BUILD_MICROSOFT_OAUTH__;
  if (typeof value !== "object" || value === null) return null;
  const { clientId, tenantId } = value as Record<string, unknown>;
  return typeof clientId === "string" &&
    typeof tenantId === "string" &&
    ENTRA_ID.test(clientId) &&
    ENTRA_ID.test(tenantId)
    ? { clientId, tenantId }
    : null;
}

export class MemorySyncSignInRequired extends Schema.TaggedError<MemorySyncSignInRequired>()(
  "MemorySyncSignInRequired",
  { message: Schema.String },
) {}

export class MemorySyncFailure extends Schema.TaggedError<MemorySyncFailure>()(
  "MemorySyncFailure",
  { message: Schema.String },
) {}

const StoredCredential = Schema.Struct({
  version: Schema.Literal(1),
  refreshToken: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
type StoredCredential = typeof StoredCredential.Type;
const decodeStoredCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCredential));
const encodeStoredCredential = Schema.encodeEffect(Schema.fromJsonString(StoredCredential));
const PluginCredential = Schema.Struct({ refreshToken: Schema.String });
const decodePluginCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginCredential));

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optionalKey(Schema.String),
});
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.optionalKey(Schema.Number),
});
const decodeDeviceCodeResponse = Schema.decodeUnknownEffect(DeviceCodeResponse);
const OAuthError = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
});
const decodeOAuthError = Schema.decodeUnknownEffect(OAuthError);
const Me = Schema.Struct({
  id: Schema.String,
  userPrincipalName: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeMe = Schema.decodeUnknownEffect(Me);

export interface DeviceCodeStart {
  readonly flowId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly intervalSeconds: number;
}

export type SignInStart =
  | { readonly kind: "connected" }
  | ({ readonly kind: "device_code" } & DeviceCodeStart);

export interface DeviceCodePoll {
  readonly state: "pending" | "connected" | "expired" | "failed";
  readonly retryAfterSeconds: number | null;
  readonly message: string | null;
}

export interface SignedInAccount {
  readonly accountId: string | null;
  readonly account: string | null;
}

export class MicrosoftSignIn extends Context.Service<
  MicrosoftSignIn,
  {
    readonly config: MicrosoftOAuthConfig | null;
    /** A current access token, signing in silently when possible. */
    readonly accessToken: Effect.Effect<string, MemorySyncSignInRequired | MemorySyncFailure>;
    /** Drops the cached access token after Graph rejects it. */
    readonly invalidateAccessToken: Effect.Effect<void>;
    readonly account: Effect.Effect<SignedInAccount | null>;
    /**
     * Signs in silently from a saved or plugin sign-in and runs
     * `onConnected`, or begins a device-code sign-in for the user to finish.
     */
    readonly start: <E>(
      onConnected: Effect.Effect<void, E>,
    ) => Effect.Effect<SignInStart, MemorySyncFailure | E>;
    /** Runs `onConnected` with the credential save once the user finishes signing in. */
    readonly pollDeviceCode: <E>(
      flowId: string,
      onConnected: Effect.Effect<void, E>,
    ) => Effect.Effect<DeviceCodePoll, MemorySyncFailure | E>;
    /**
     * Ends sign-ins in progress. Their device codes stop working, and none of
     * them can save a credential or run its `onConnected` afterwards.
     */
    readonly cancelSignIn: Effect.Effect<void>;
    /** Cancels sign-ins in progress and forgets the saved credential. */
    readonly signOut: Effect.Effect<void, MemorySyncFailure>;
  }
>()("t3/memory/sync/microsoftSignIn") {}

interface PendingFlow {
  readonly deviceCode: string;
  readonly generation: number;
  readonly expiresAtMs: number;
  intervalSeconds: number;
}

function describeOAuthError(error: {
  readonly error: string;
  readonly error_description?: string;
}) {
  // Entra appends trace and correlation ids after the first line.
  const summary = error.error_description?.split(/\r?\n/u)[0]?.trim();
  return summary && summary.length > 0 ? summary : error.error;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = (config: MicrosoftOAuthConfig | null) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const cached = yield* Ref.make<{ readonly token: string; readonly expiresAtMs: number } | null>(
      null,
    );
    const flows = yield* Ref.make(new Map<string, PendingFlow>());
    // Cancelling and signing out start a new generation. A sign-in begun in an
    // earlier one may still finish at Microsoft, but `commit` will not save it.
    const generation = yield* Ref.make(0);
    const commitLock = yield* Semaphore.make(1);
    const failure = (message: string) => new MemorySyncFailure({ message });

    /** Runs `effect` unless a cancel or sign-out came after `since`; None when one did. */
    const commit = <A, E>(since: number, effect: Effect.Effect<A, E>) =>
      commitLock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(generation)) !== since) return Option.none<A>();
          return Option.some(yield* effect);
        }),
      );
    const cancelled = failure("Sign-in was cancelled.");

    const send = (request: HttpClientRequest.HttpClientRequest) =>
      httpClient.execute(request).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed((): unknown => null),
            Effect.map((json) => ({ status: response.status, json })),
          ),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(() => failure("Could not reach Microsoft sign-in. Check your connection.")),
      );

    const postForm = (endpoint: "devicecode" | "token", params: Record<string, string>) =>
      Effect.gen(function* () {
        if (!config) return yield* failure("This build has no Microsoft sign-in configured.");
        return yield* send(
          HttpClientRequest.post(
            `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/${endpoint}`,
          ).pipe(HttpClientRequest.bodyUrlParams({ client_id: config.clientId, ...params })),
        );
      });

    const readSecret = (name: string) =>
      secrets.get(name).pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.orElseSucceed(() => Option.none<string>()),
      );

    const readOwnCredential = readSecret(OWN_SECRET).pipe(
      Effect.flatMap((raw) =>
        Option.isSome(raw)
          ? decodeStoredCredential(raw.value).pipe(
              Effect.map((credential) => Option.some(credential)),
              Effect.orElseSucceed(() => Option.none<StoredCredential>()),
            )
          : Effect.succeed(Option.none<StoredCredential>()),
      ),
    );

    const saveOwnCredential = (credential: StoredCredential) =>
      encodeStoredCredential(credential).pipe(
        Effect.flatMap((json) => secrets.set(OWN_SECRET, new TextEncoder().encode(json))),
        Effect.mapError(() => failure("Could not save the Microsoft sign-in.")),
      );

    const fetchAccount = (accessToken: string) =>
      Effect.gen(function* () {
        const { status, json } = yield* send(
          HttpClientRequest.get(
            "https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName",
          ).pipe(HttpClientRequest.bearerToken(accessToken)),
        );
        if (status !== 200) return null;
        return yield* decodeMe(json).pipe(Effect.orElseSucceed(() => null));
      }).pipe(Effect.orElseSucceed(() => null));

    /** Exchanges a refresh token for OneDrive access; Entra may rotate the refresh token. */
    const redeem = (refreshToken: string) =>
      Effect.gen(function* () {
        const { status, json } = yield* postForm("token", {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: SCOPES,
        });
        if (status === 200) {
          return yield* decodeTokenResponse(json).pipe(
            Effect.mapError(() => failure("Microsoft returned an unexpected token response.")),
          );
        }
        const error = yield* decodeOAuthError(json).pipe(
          Effect.orElseSucceed(() => ({ error: `http_${status}` })),
        );
        if (error.error === "invalid_grant" || error.error === "interaction_required") {
          return yield* new MemorySyncSignInRequired({
            message: "Your Microsoft sign-in expired. Sign in again to keep syncing.",
          });
        }
        return yield* failure(`Microsoft sign-in failed: ${describeOAuthError(error)}`);
      });

    const cacheToken = (token: typeof TokenResponse.Type) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.set(cached, {
            token: token.access_token,
            expiresAtMs: now + token.expires_in * 1000,
          }),
        ),
      );

    const accessToken = Effect.gen(function* () {
      const since = yield* Ref.get(generation);
      const now = yield* Clock.currentTimeMillis;
      const current = yield* Ref.get(cached);
      if (current && current.expiresAtMs - ACCESS_TOKEN_SKEW_MS > now) return current.token;

      const own = yield* readOwnCredential;
      if (Option.isSome(own)) {
        const token = yield* redeem(own.value.refreshToken).pipe(
          Effect.tapError((error) =>
            error._tag === "MemorySyncSignInRequired"
              ? secrets.remove(OWN_SECRET).pipe(Effect.ignore)
              : Effect.void,
          ),
        );
        // Turning sync off does not end this sign-in; only signing out does.
        const saved = yield* commitLock.withPermits(1)(
          Effect.gen(function* () {
            const stored = yield* readOwnCredential;
            if (Option.isNone(stored)) return false;
            if (stored.value.refreshToken !== own.value.refreshToken) return true;
            yield* saveOwnCredential({
              ...own.value,
              refreshToken: token.refresh_token ?? own.value.refreshToken,
              updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
            });
            yield* cacheToken(token);
            return true;
          }),
        );
        if (!saved) {
          return yield* new MemorySyncSignInRequired({
            message: "Sign in with your Microsoft account to sync memory.",
          });
        }
        return token.access_token;
      }

      // Reuse the Microsoft 365 plugin's sign-in when it is connected.
      const plugin = yield* readSecret(PLUGIN_SECRET);
      if (Option.isSome(plugin)) {
        const pluginCredential = yield* decodePluginCredential(plugin.value).pipe(Effect.option);
        if (Option.isSome(pluginCredential)) {
          const token = yield* redeem(pluginCredential.value.refreshToken).pipe(
            Effect.catchTag("MemorySyncSignInRequired", () => Effect.succeed(null)),
          );
          if (token?.refresh_token) {
            const refreshToken = token.refresh_token;
            const me = yield* fetchAccount(token.access_token);
            const saved = yield* commit(
              since,
              saveOwnCredential({
                version: 1,
                refreshToken,
                accountId: me?.id ?? null,
                account: me?.userPrincipalName ?? null,
                updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              }).pipe(Effect.andThen(cacheToken(token))),
            );
            if (Option.isNone(saved)) return yield* cancelled;
            return token.access_token;
          }
        }
      }
      return yield* new MemorySyncSignInRequired({
        message: "Sign in with your Microsoft account to sync memory.",
      });
    });

    const account = readOwnCredential.pipe(
      Effect.map((own) =>
        Option.isSome(own) ? { accountId: own.value.accountId, account: own.value.account } : null,
      ),
    );

    const startDeviceCode = (since: number) =>
      Effect.gen(function* () {
        const { status, json } = yield* postForm("devicecode", { scope: SCOPES });
        if (status !== 200) {
          const error = yield* decodeOAuthError(json).pipe(
            Effect.orElseSucceed(() => ({ error: `http_${status}` })),
          );
          return yield* failure(`Microsoft sign-in failed: ${describeOAuthError(error)}`);
        }
        const code = yield* decodeDeviceCodeResponse(json).pipe(
          Effect.mapError(() => failure("Microsoft returned an unexpected sign-in response.")),
        );
        const now = yield* Clock.currentTimeMillis;
        const flowId = NodeCrypto.createHash("sha256")
          .update(code.device_code)
          .digest("hex")
          .slice(0, 32);
        const intervalSeconds = Math.min(Math.max(code.interval ?? 5, 1), 60);
        const expiresAtMs = now + Math.min(Math.max(code.expires_in, 60), 1800) * 1000;
        const registered = yield* commit(
          since,
          Ref.update(flows, (current) =>
            new Map(current).set(flowId, {
              deviceCode: code.device_code,
              generation: since,
              expiresAtMs,
              intervalSeconds,
            }),
          ),
        );
        if (Option.isNone(registered)) return yield* cancelled;
        return {
          flowId,
          userCode: code.user_code,
          verificationUri: code.verification_uri,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)),
          intervalSeconds,
        } satisfies DeviceCodeStart;
      });

    const start = <E>(onConnected: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        const since = yield* Ref.get(generation);
        const signedIn = yield* accessToken.pipe(
          Effect.as(true),
          Effect.catchTag("MemorySyncSignInRequired", () => Effect.succeed(false)),
        );
        if (!signedIn) {
          return { kind: "device_code", ...(yield* startDeviceCode(since)) } satisfies SignInStart;
        }
        if (Option.isNone(yield* commit(since, onConnected))) return yield* cancelled;
        return { kind: "connected" } satisfies SignInStart;
      });

    const pollDeviceCode = <E>(flowId: string, onConnected: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        const flow = (yield* Ref.get(flows)).get(flowId);
        const now = yield* Clock.currentTimeMillis;
        // Leaves a newer sign-in alone if it reused this id.
        const finish = Ref.update(flows, (current) => {
          if (current.get(flowId) !== flow) return current;
          const next = new Map(current);
          next.delete(flowId);
          return next;
        });
        if (!flow || flow.expiresAtMs <= now) {
          yield* finish;
          return {
            state: "expired",
            retryAfterSeconds: null,
            message: "The sign-in code expired. Start again.",
          } satisfies DeviceCodePoll;
        }
        const { status, json } = yield* postForm("token", {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: flow.deviceCode,
        });
        if (status === 200) {
          const token = yield* decodeTokenResponse(json).pipe(
            Effect.mapError(() => failure("Microsoft returned an unexpected token response.")),
          );
          if (!token.refresh_token) {
            return yield* failure("Microsoft did not return a lasting sign-in. Try again.");
          }
          const refreshToken = token.refresh_token;
          const me = yield* fetchAccount(token.access_token);
          const connected = yield* commit(
            flow.generation,
            Effect.gen(function* () {
              yield* saveOwnCredential({
                version: 1,
                refreshToken,
                accountId: me?.id ?? null,
                account: me?.userPrincipalName ?? null,
                updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
              });
              yield* cacheToken(token);
              yield* onConnected;
            }),
          );
          yield* finish;
          if (Option.isNone(connected)) {
            return {
              state: "expired",
              retryAfterSeconds: null,
              message: "Sign-in was cancelled. Turn sync on to try again.",
            } satisfies DeviceCodePoll;
          }
          return {
            state: "connected",
            retryAfterSeconds: null,
            message: null,
          } satisfies DeviceCodePoll;
        }
        const error = yield* decodeOAuthError(json).pipe(
          Effect.orElseSucceed(() => ({ error: `http_${status}` })),
        );
        if (error.error === "authorization_pending" || error.error === "slow_down") {
          if (error.error === "slow_down")
            flow.intervalSeconds = Math.min(flow.intervalSeconds + 5, 60);
          return {
            state: "pending",
            retryAfterSeconds: flow.intervalSeconds,
            message: null,
          } satisfies DeviceCodePoll;
        }
        yield* finish;
        return {
          state: error.error === "expired_token" ? "expired" : "failed",
          retryAfterSeconds: null,
          message: describeOAuthError(error),
        } satisfies DeviceCodePoll;
      });

    const cancel = Effect.gen(function* () {
      yield* Ref.update(generation, (current) => current + 1);
      yield* Ref.set(flows, new Map());
    });

    const signOut = commitLock.withPermits(1)(
      Effect.gen(function* () {
        yield* cancel;
        yield* Ref.set(cached, null);
        yield* secrets
          .remove(OWN_SECRET)
          .pipe(Effect.mapError(() => failure("Could not remove the Microsoft sign-in.")));
      }),
    );

    return MicrosoftSignIn.of({
      config,
      accessToken,
      invalidateAccessToken: Ref.set(cached, null),
      account,
      start,
      pollDeviceCode,
      cancelSignIn: commitLock.withPermits(1)(cancel),
      signOut,
    });
  });

export const layer = Layer.effect(MicrosoftSignIn, make(builtMicrosoftOAuthConfig()));
