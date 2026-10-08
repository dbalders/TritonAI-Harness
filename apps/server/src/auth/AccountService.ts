import * as NodeCrypto from "node:crypto";
import { accountCallbackId } from "@t3tools/shared/accountCallback";

import { AccountProfile, type AccountStatus, ServerAccountError } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerSecretStore } from "./ServerSecretStore.ts";

const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048));
const EpochSeconds = Schema.Int.check(Schema.isGreaterThan(0));
const LoginStart = Schema.Struct({
  requestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  verificationUrl: ShortText,
  userCode: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z0-9]{8}$/u))),
  returnUrl: Schema.optionalKey(Schema.String),
  expiresAt: EpochSeconds,
  pollIntervalSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
});
const Credential = Schema.Struct({
  accessToken: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
  expiresAt: EpochSeconds,
  profile: AccountProfile,
  renewalToken: Schema.optionalKey(ShortText),
  renewalExpiresAt: Schema.optionalKey(EpochSeconds),
});
type Credential = typeof Credential.Type;
const Me = Schema.Struct({
  profile: AccountProfile,
  expiresAt: EpochSeconds,
  renewalExpiresAt: Schema.optionalKey(EpochSeconds),
});
const decodeStart = Schema.decodeUnknownEffect(Schema.fromJsonString(LoginStart));
const decodeCredential = Schema.decodeUnknownEffect(Schema.fromJsonString(Credential));
const encodeCredential = Schema.encodeSync(Schema.fromJsonString(Credential));
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMe = Schema.decodeUnknownEffect(Schema.fromJsonString(Me));
const decodePending = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ pending: Schema.Literal(true) })),
);

const error = (code: ServerAccountError["code"], message: string) =>
  new ServerAccountError({ code, message });
const invalidResponse = () =>
  error("invalid_response", "The account service returned an invalid response.");
const storageError = () =>
  error("storage_error", "The account credential could not be read or saved securely.");

export function resolveAccountServiceUrl(
  value: string,
  allowInsecureLoopback = false,
): string | null {
  if (!value.trim() || value.trim() === "disabled") return null;
  try {
    const url = new URL(value.trim());
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (
      (url.protocol !== "https:" &&
        !(allowInsecureLoopback && loopback && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Invalid account origin");
    }
    return url.origin;
  } catch {
    throw error(
      "invalid_configuration",
      "The configured account service must be a trusted HTTPS origin.",
    );
  }
}

interface PendingLogin {
  readonly generation: number;
  readonly verifier: string;
  readonly response: typeof LoginStart.Type;
  nextPollAt: number;
}
interface SessionLane {
  readonly semaphore: Semaphore.Semaphore;
  generation: number;
  pending: PendingLogin | null;
}
interface LoginOptions {
  readonly returnUrl?: string;
}
interface LoginCompletion {
  readonly requestId?: string;
  readonly completionCode?: string;
}

export class AccountService extends Context.Service<
  AccountService,
  {
    readonly getStatus: (sessionId: string) => Effect.Effect<AccountStatus, ServerAccountError>;
    readonly startLogin: (
      sessionId: string,
      options?: LoginOptions,
    ) => Effect.Effect<AccountStatus, ServerAccountError>;
    readonly pollLogin: (
      sessionId: string,
      completion?: LoginCompletion,
    ) => Effect.Effect<AccountStatus, ServerAccountError>;
    readonly signOut: (sessionId: string) => Effect.Effect<AccountStatus, ServerAccountError>;
  }
>()("t3/auth/AccountService") {}

/** One instance per environment server; the authenticated local session is the ownership boundary. */
export const make = (
  options: {
    readonly serviceUrl?: string;
    readonly allowInsecureLoopback?: boolean;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => number;
  } = {},
) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const clock = yield* Clock.Clock;
    const serviceUrl = yield* Effect.try({
      try: () => resolveAccountServiceUrl(options.serviceUrl ?? "", options.allowInsecureLoopback),
      catch: () => error("invalid_configuration", "The account service configuration is invalid."),
    });
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const now = options.now ?? (() => Math.floor(clock.currentTimeMillisUnsafe() / 1000));
    const lanes = new Map<string, SessionLane>();
    const getLane = (sessionId: string) => {
      let lane = lanes.get(sessionId);
      if (!lane) {
        lane = { semaphore: Semaphore.makeUnsafe(1), generation: 0, pending: null };
        lanes.set(sessionId, lane);
      }
      return lane;
    };
    const secretName = (sessionId: string) =>
      `account-session-${NodeCrypto.createHash("sha256").update(`${serviceUrl}\0${sessionId}`).digest("hex")}`;
    const signedOut = (): AccountStatus => ({
      configured: serviceUrl !== null,
      status: "signed-out",
      serviceUrl,
      profile: null,
      expiresAt: null,
      verificationUrl: null,
      userCode: null,
      pollIntervalSeconds: null,
    });
    const pendingStatus = (pending: PendingLogin): AccountStatus => ({
      ...signedOut(),
      status: "pending",
      expiresAt: pending.response.expiresAt,
      verificationUrl: pending.response.verificationUrl,
      userCode: pending.response.userCode,
      pollIntervalSeconds: pending.response.pollIntervalSeconds,
      ...(pending.response.returnUrl ? { returnUrl: pending.response.returnUrl } : {}),
    });
    const signedIn = (
      credential: Pick<Credential, "profile" | "expiresAt" | "renewalExpiresAt">,
    ): AccountStatus => ({
      ...signedOut(),
      status: "signed-in",
      profile: credential.profile,
      expiresAt: credential.expiresAt,
      ...(credential.renewalExpiresAt !== undefined
        ? { renewalExpiresAt: credential.renewalExpiresAt }
        : {}),
    });
    const remove = (sessionId: string) =>
      secrets.remove(secretName(sessionId)).pipe(Effect.mapError(storageError));
    const save = (sessionId: string, credential: Credential) =>
      secrets
        .set(secretName(sessionId), new TextEncoder().encode(encodeCredential(credential)))
        .pipe(Effect.mapError(storageError));
    const read = Effect.fn("AccountService.read")(function* (sessionId: string) {
      const bytes = yield* secrets.get(secretName(sessionId)).pipe(Effect.mapError(storageError));
      if (Option.isNone(bytes)) return null;
      const credential = yield* decodeCredential(new TextDecoder().decode(bytes.value)).pipe(
        Effect.mapError(storageError),
      );
      if (
        credential.expiresAt <= now() &&
        (!credential.renewalToken ||
          !credential.renewalExpiresAt ||
          credential.renewalExpiresAt <= now())
      ) {
        yield* remove(sessionId);
        return null;
      }
      return credential;
    });
    const request = (path: string, input?: { token?: string; body?: unknown; method?: string }) =>
      Effect.tryPromise({
        try: (signal) =>
          fetchImpl(`${serviceUrl}${path}`, {
            method: input?.method ?? (input?.body === undefined ? "GET" : "POST"),
            headers: {
              Accept: "application/json",
              ...(input?.token ? { Authorization: `Bearer ${input.token}` } : {}),
              ...(input?.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(input?.body === undefined ? {} : { body: encodeBody(input.body) }),
            redirect: "error",
            credentials: "omit",
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          }),
        catch: () => error("unavailable", "The account service could not be reached. Try again."),
      });
    const responseText = (response: Response) =>
      Effect.tryPromise({
        try: async () => {
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Missing body");
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              length += value.length;
              if (length > 32_768) throw new Error("Oversize response");
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          return new TextDecoder().decode(Buffer.concat(chunks));
        },
        catch: invalidResponse,
      }).pipe(Effect.timeout("10 seconds"), Effect.mapError(invalidResponse));
    const revoke = Effect.fn("AccountService.revoke")(function* (credential: Credential) {
      const response = yield* request("/v1/logout", {
        token: credential.renewalToken ?? credential.accessToken,
        method: "POST",
      });
      if (![204, 401].includes(response.status)) {
        return yield* error(
          "request_rejected",
          "Sign-out was not confirmed. Try again to revoke access.",
        );
      }
    });
    const statusLocked = Effect.fn("AccountService.statusLocked")(function* (
      sessionId: string,
      lane: SessionLane,
    ) {
      if (!serviceUrl) return signedOut();
      const generation = lane.generation;
      let credential = yield* read(sessionId);
      if (credential) {
        if (
          credential.renewalToken &&
          credential.renewalExpiresAt &&
          credential.expiresAt <= now() + 300
        ) {
          const renewal = yield* request("/v1/session/refresh", {
            token: credential.renewalToken,
            method: "POST",
          });
          if ([401, 403].includes(renewal.status)) {
            yield* remove(sessionId);
            return signedOut();
          }
          if (renewal.status !== 200)
            return yield* error(
              "unavailable",
              "Your sign-in could not be renewed yet. Harness will retry.",
            );
          const renewed = yield* responseText(renewal).pipe(
            Effect.flatMap(decodeCredential),
            Effect.mapError(invalidResponse),
          );
          if (
            renewed.profile.issuer !== credential.profile.issuer ||
            renewed.profile.subject !== credential.profile.subject ||
            renewed.expiresAt <= now() ||
            renewed.expiresAt > now() + 3660 ||
            renewed.expiresAt > credential.renewalExpiresAt ||
            renewed.renewalExpiresAt !== credential.renewalExpiresAt
          )
            return yield* invalidResponse();
          credential = {
            ...credential,
            accessToken: renewed.accessToken,
            profile: renewed.profile,
            expiresAt: renewed.expiresAt,
          };
          yield* save(sessionId, credential).pipe(Effect.uninterruptible);
        }
        const response = yield* request("/v1/me", { token: credential.accessToken });
        if (response.status === 401 || response.status === 403) {
          yield* remove(sessionId);
          return signedOut();
        }
        if (response.status !== 200) {
          return yield* error(
            "request_rejected",
            "The account service could not confirm your identity.",
          );
        }
        const me = yield* responseText(response).pipe(
          Effect.flatMap(decodeMe),
          Effect.mapError(invalidResponse),
        );
        if (
          me.expiresAt <= now() ||
          me.expiresAt > credential.expiresAt ||
          me.profile.issuer !== credential.profile.issuer ||
          me.profile.subject !== credential.profile.subject
        ) {
          yield* remove(sessionId);
          return yield* invalidResponse();
        }
        return generation === lane.generation
          ? signedIn({
              ...me,
              ...(credential.renewalExpiresAt !== undefined
                ? { renewalExpiresAt: credential.renewalExpiresAt }
                : {}),
            })
          : signedOut();
      }
      if (lane.pending && lane.pending.response.expiresAt > now())
        return pendingStatus(lane.pending);
      lane.pending = null;
      return signedOut();
    });

    const getStatus = Effect.fn("AccountService.getStatus")(function* (sessionId: string) {
      const lane = getLane(sessionId);
      return yield* lane.semaphore.withPermit(statusLocked(sessionId, lane));
    });
    const startLogin = Effect.fn("AccountService.startLogin")(function* (
      sessionId: string,
      options: LoginOptions = {},
    ) {
      const lane = getLane(sessionId);
      const generation = lane.generation;
      return yield* lane.semaphore.withPermit(
        Effect.gen(function* () {
          if (!serviceUrl)
            return yield* error(
              "not_configured",
              "UC San Diego sign-in is not configured on this server.",
            );
          if (generation !== lane.generation) return signedOut();
          const current = yield* statusLocked(sessionId, lane);
          if (generation !== lane.generation) return signedOut();
          if (current.status !== "signed-out") return current;
          if (options.returnUrl !== undefined && !accountCallbackId(options.returnUrl))
            return yield* error("request_rejected", "Invalid native sign-in callback.");
          const verifier = NodeCrypto.randomBytes(48).toString("base64url");
          const codeChallenge = NodeCrypto.createHash("sha256")
            .update(verifier)
            .digest("base64url");
          const response = yield* request("/v1/login/start", {
            body: { codeChallenge, ...options },
          });
          if (response.status !== 200)
            return yield* error("request_rejected", "The account service could not start sign-in.");
          const started = yield* responseText(response).pipe(
            Effect.flatMap(decodeStart),
            Effect.mapError(invalidResponse),
          );
          const verification = yield* Effect.try({
            try: () => new URL(started.verificationUrl),
            catch: invalidResponse,
          });
          if (
            verification.origin !== serviceUrl ||
            verification.pathname !== "/login" ||
            verification.username ||
            verification.password ||
            verification.hash ||
            verification.searchParams.get("requestId") !== started.requestId ||
            [...verification.searchParams.keys()].some((key) => key !== "requestId") ||
            verification.searchParams.getAll("requestId").length !== 1 ||
            started.returnUrl !== options.returnUrl ||
            (options.returnUrl ? started.userCode !== null : started.userCode === null) ||
            started.expiresAt <= now() ||
            started.expiresAt > now() + 900
          )
            return yield* invalidResponse();
          if (generation !== lane.generation) return signedOut();
          lane.pending = {
            generation,
            verifier,
            response: started,
            nextPollAt: now() + started.pollIntervalSeconds,
          };
          return pendingStatus(lane.pending);
        }),
      );
    });
    const pollLogin = Effect.fn("AccountService.pollLogin")(function* (
      sessionId: string,
      completion: LoginCompletion = {},
    ) {
      const lane = getLane(sessionId);
      return yield* lane.semaphore.withPermit(
        Effect.gen(function* () {
          const pending = lane.pending;
          if (!pending) return yield* statusLocked(sessionId, lane);
          if (pending.response.expiresAt <= now()) {
            lane.pending = null;
            return yield* error("login_expired", "Sign-in expired. Start again.");
          }
          if (
            completion.requestId !== undefined &&
            completion.requestId !== pending.response.requestId
          )
            return yield* error("request_rejected", "This callback belongs to another sign-in.");
          if (pending.response.returnUrl && !completion.completionCode)
            return pendingStatus(pending);
          if (
            pending.response.returnUrl &&
            (!/^[A-Za-z0-9_-]{43}$/u.test(completion.completionCode ?? "") || !completion.requestId)
          )
            return yield* error("request_rejected", "Invalid native sign-in callback.");
          if (!completion.completionCode && pending.nextPollAt > now())
            return pendingStatus(pending);
          pending.nextPollAt = now() + pending.response.pollIntervalSeconds;
          const response = yield* request("/v1/login/token", {
            body: {
              requestId: pending.response.requestId,
              codeVerifier: pending.verifier,
              ...(completion.completionCode ? { completionCode: completion.completionCode } : {}),
            },
          });
          if (response.status === 202) {
            yield* responseText(response).pipe(
              Effect.flatMap(decodePending),
              Effect.mapError(invalidResponse),
            );
            return lane.generation === pending.generation ? pendingStatus(pending) : signedOut();
          }
          if (response.status !== 200) {
            if ([400, 401, 403, 404, 410].includes(response.status)) lane.pending = null;
            return yield* error(
              "request_rejected",
              "The account service could not complete sign-in. Start again.",
            );
          }
          const credential = yield* responseText(response).pipe(
            Effect.flatMap(decodeCredential),
            Effect.mapError(invalidResponse),
          );
          if (
            (credential.renewalToken === undefined) !==
              (credential.renewalExpiresAt === undefined) ||
            (credential.renewalExpiresAt !== undefined &&
              (!/^[A-Za-z0-9_-]{43}$/u.test(credential.renewalToken ?? "") ||
                credential.renewalExpiresAt <= credential.expiresAt ||
                credential.renewalExpiresAt > now() + 30 * 86400 + 60))
          )
            return yield* invalidResponse();
          if (credential.expiresAt <= now() || credential.expiresAt > now() + 3_660)
            return yield* invalidResponse();
          // Keep a late token recoverable if cancellation's remote revocation fails. The waiting
          // sign-out can retry; no success state is returned until its revocation is confirmed.
          yield* save(sessionId, credential).pipe(Effect.uninterruptible);
          lane.pending = null;
          if (lane.generation !== pending.generation) {
            yield* revoke(credential);
            yield* remove(sessionId);
            return signedOut();
          }
          return signedIn(credential);
        }),
      );
    });
    const signOut = Effect.fn("AccountService.signOut")(function* (sessionId: string) {
      const lane = getLane(sessionId);
      // Invalidate before waiting for the lane: an already-running poll must not resurrect login.
      lane.generation++;
      lane.pending = null;
      return yield* lane.semaphore.withPermit(
        Effect.gen(function* () {
          lane.pending = null;
          const credential = yield* read(sessionId);
          if (credential) yield* revoke(credential);
          yield* remove(sessionId);
          return signedOut();
        }),
      );
    });
    // The environment owns renewal, so leaving Settings does not stop keeping sign-in alive.
    if (serviceUrl) {
      yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("60 seconds");
          yield* Effect.forEach(
            [...lanes.entries()],
            ([sessionId, lane]) =>
              lane.semaphore
                .withPermit(
                  Effect.gen(function* () {
                    const credential = yield* read(sessionId);
                    if (credential?.renewalToken && credential.expiresAt <= now() + 300)
                      yield* statusLocked(sessionId, lane);
                  }),
                )
                .pipe(Effect.catch(() => Effect.void)),
            { concurrency: 4, discard: true },
          );
        }
      }).pipe(Effect.forkScoped);
    }
    return AccountService.of({ getStatus, startLogin, pollLogin, signOut });
  });

export const layer = Layer.effect(
  AccountService,
  Effect.gen(function* () {
    const serviceUrl = yield* Config.String("TRITONAI_ACCOUNT_SERVICE_URL").pipe(
      Config.withDefault("https://23ys8aak93.execute-api.us-west-2.amazonaws.com"),
    );
    const allowInsecureLoopback = yield* Config.String(
      "TRITONAI_ACCOUNT_ALLOW_INSECURE_LOOPBACK",
    ).pipe(Config.withDefault("0"));
    return yield* make({ serviceUrl, allowInsecureLoopback: allowInsecureLoopback === "1" }).pipe(
      Effect.catchIf(
        (cause) => cause.code === "invalid_configuration",
        () =>
          Effect.logWarning(
            "UC San Diego sign-in is disabled because the account service configuration is invalid.",
          ).pipe(Effect.andThen(make())),
      ),
    );
  }),
);
