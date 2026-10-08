import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Account from "./AccountService.ts";
import { ServerSecretStore } from "./ServerSecretStore.ts";

const serviceUrl = "https://accounts.example.test";
const requestId = "r".repeat(43);
const profile = {
  issuer: "https://identity.example.test",
  subject: "immutable-user-a",
  email: "staff@example.test",
  displayName: "Test Staff",
};
const token = "synthetic-account-secret";
const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeChallenge = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ codeChallenge: Schema.String })),
);
const decodeVerifier = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ codeVerifier: Schema.String })),
);

function fixture(overrides?: {
  fetch?: typeof globalThis.fetch;
  serviceUrl?: string;
  allowInsecureLoopback?: boolean;
  beforeRead?: Effect.Effect<void>;
}) {
  const values = new Map<string, Uint8Array>();
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let time = 1_800_000_000;
  const store: ServerSecretStore["Service"] = {
    get: (name) =>
      (overrides?.beforeRead ?? Effect.void).pipe(
        Effect.andThen(Effect.sync(() => Option.fromNullishOr(values.get(name)))),
      ),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
  };
  const startResponse = () => ({
    requestId,
    verificationUrl: `${serviceUrl}/login?requestId=${requestId}`,
    userCode: "ABCD1234",
    expiresAt: time + 600,
    pollIntervalSeconds: 2,
  });
  const credential = () => ({ accessToken: token, profile, expiresAt: time + 3_600 });
  const defaultFetch: typeof globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/login/start") return Response.json(startResponse());
    if (path === "/v1/login/token") return Response.json(credential());
    if (path === "/v1/me") return Response.json({ profile, expiresAt: time + 3_600 });
    if (path === "/v1/logout") return new Response(null, { status: 204 });
    throw new Error("Unexpected fixture request");
  };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return (overrides?.fetch ?? defaultFetch)(input, init);
  };
  return {
    values,
    store,
    calls,
    startResponse,
    credential,
    defaultFetch,
    advance: (seconds: number) => {
      time += seconds;
    },
    make: Account.make({
      serviceUrl: overrides?.serviceUrl ?? serviceUrl,
      ...(overrides?.allowInsecureLoopback === undefined
        ? {}
        : { allowInsecureLoopback: overrides.allowInsecureLoopback }),
      fetch: fetchImpl,
      now: () => time,
    }).pipe(Effect.provideService(ServerSecretStore, store)),
  };
}

describe("AccountService", () => {
  it.effect.each([{}, { TRITONAI_ACCOUNT_SERVICE_URL: "" }])(
    "offers campus sign-in without a launch-time account URL: %j",
    (env) =>
      Effect.gen(function* () {
        const f = fixture();
        const configuredLayer = Account.layer.pipe(
          Layer.provide(Layer.succeed(ServerSecretStore, f.store)),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        );
        const status = yield* Effect.gen(function* () {
          const account = yield* Account.AccountService;
          return yield* account.getStatus("local-a");
        }).pipe(Effect.provide(configuredLayer));
        expect(status).toMatchObject({
          configured: true,
          status: "signed-out",
          serviceUrl: "https://23ys8aak93.execute-api.us-west-2.amazonaws.com",
        });
        expect(f.calls).toHaveLength(0);
      }),
  );

  it.effect.each(["disabled", "   "])(
    "allows an explicit account override to disable sign-in: %j",
    (value) =>
      Effect.gen(function* () {
        const f = fixture();
        const configuredLayer = Account.layer.pipe(
          Layer.provide(Layer.succeed(ServerSecretStore, f.store)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { TRITONAI_ACCOUNT_SERVICE_URL: value } }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const account = yield* Account.AccountService;
          expect(yield* account.getStatus("local-a")).toMatchObject({
            configured: false,
            serviceUrl: null,
            status: "signed-out",
          });
          expect((yield* Effect.flip(account.startLogin("local-a"))).code).toBe("not_configured");
        }).pipe(Effect.provide(configuredLayer));
        expect(f.calls).toHaveLength(0);
      }),
  );

  it.effect("keeps the account layer available when its optional URL is invalid", () =>
    Effect.gen(function* () {
      const f = fixture();
      for (const value of ["not-a-url", `${serviceUrl}/prod`, "http://accounts.example.test"]) {
        const configuredLayer = Account.layer.pipe(
          Layer.provide(Layer.succeed(ServerSecretStore, f.store)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { TRITONAI_ACCOUNT_SERVICE_URL: value } }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const account = yield* Account.AccountService;
          expect(yield* account.getStatus("local-a")).toMatchObject({
            configured: false,
            status: "signed-out",
          });
          expect((yield* Effect.flip(account.startLogin("local-a"))).code).toBe("not_configured");
        }).pipe(Effect.provide(configuredLayer));
      }
    }),
  );

  it.effect("keeps sign-in configured when the account URL is valid", () =>
    Effect.gen(function* () {
      const f = fixture();
      const configuredLayer = Account.layer.pipe(
        Layer.provide(Layer.succeed(ServerSecretStore, f.store)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { TRITONAI_ACCOUNT_SERVICE_URL: serviceUrl } }),
          ),
        ),
      );
      const status = yield* Effect.gen(function* () {
        const account = yield* Account.AccountService;
        return yield* account.getStatus("local-a");
      }).pipe(Effect.provide(configuredLayer));
      expect(status).toMatchObject({ configured: true, status: "signed-out", serviceUrl });
    }),
  );

  it.effect.each(["http://127.0.0.1:45123/account/callback/", "t3code-dev:///account/callback/"])(
    "waits for the owning native callback rather than exchanging on a background poll: %s",
    (base) =>
      Effect.gen(function* () {
        const returnUrl = `${base}${"c".repeat(43)}`;
        const f = fixture({
          fetch: async (input, init) => {
            if (String(input).endsWith("/v1/login/start"))
              return Response.json({ ...f.startResponse(), userCode: null, returnUrl });
            return f.defaultFetch(input, init);
          },
        });
        const account = yield* f.make;
        expect(yield* account.startLogin("local-a", { returnUrl })).toMatchObject({
          status: "pending",
          userCode: null,
          returnUrl,
        });
        f.advance(5);
        expect((yield* account.pollLogin("local-a")).status).toBe("pending");
        expect(f.calls).toHaveLength(1);
        const completionCode = "p".repeat(43);
        expect((yield* account.pollLogin("local-b", { requestId, completionCode })).status).toBe(
          "signed-out",
        );
        expect(
          (yield* Effect.flip(account.pollLogin("local-a", { requestId: "wrong", completionCode })))
            .code,
        ).toBe("request_rejected");
        expect(f.calls).toHaveLength(1);
        expect((yield* account.pollLogin("local-a", { requestId, completionCode })).status).toBe(
          "signed-in",
        );
        expect(String(f.calls.at(-1)?.init?.body)).toContain(completionCode);
        expect(encodeUnknown(yield* account.getStatus("local-a"))).not.toContain(completionCode);
      }),
  );
  it("accepts only a configured secure origin or explicit loopback development origin", () => {
    expect(Account.resolveAccountServiceUrl("")).toBeNull();
    expect(Account.resolveAccountServiceUrl(`${serviceUrl}/`)).toBe(serviceUrl);
    expect(Account.resolveAccountServiceUrl("http://127.0.0.1:8788", true)).toBe(
      "http://127.0.0.1:8788",
    );
    for (const value of [
      "http://127.0.0.1:8788",
      "http://accounts.example.test",
      "https://user:pass@accounts.example.test",
      `${serviceUrl}/untrusted/path`,
      `${serviceUrl}?override=1`,
      `${serviceUrl}#fragment`,
    ])
      expect(() => Account.resolveAccountServiceUrl(value)).toThrow();
    expect(() => Account.resolveAccountServiceUrl("http://accounts.example.test", true)).toThrow();
  });

  it.effect("keeps an unconfigured server signed out without making requests", () =>
    Effect.gen(function* () {
      const f = fixture({ serviceUrl: "" });
      const account = yield* f.make;
      expect(yield* account.getStatus("local-a")).toMatchObject({
        configured: false,
        status: "signed-out",
      });
      expect((yield* Effect.flip(account.startLogin("local-a"))).code).toBe("not_configured");
      expect(f.calls).toHaveLength(0);
    }),
  );

  it.effect("binds PKCE and stored credentials to the authenticated local session", () =>
    Effect.gen(function* () {
      const f = fixture();
      const account = yield* f.make;
      const start = yield* account.startLogin("local-a");
      expect(start.status).toBe("pending");
      expect(start.pollIntervalSeconds).toBe(2);
      expect(yield* account.pollLogin("local-b")).toMatchObject({ status: "signed-out" });
      expect(yield* account.pollLogin("local-a")).toEqual(start);
      expect(f.calls).toHaveLength(1);
      f.advance(2);
      const signedIn = yield* account.pollLogin("local-a");
      expect(signedIn).toMatchObject({ status: "signed-in", profile });
      expect(encodeUnknown(signedIn)).not.toContain(token);
      expect(encodeUnknown(start)).not.toContain("codeVerifier");
      const challenge = decodeChallenge(String(f.calls[0]?.init?.body)).codeChallenge;
      const verifier = decodeVerifier(String(f.calls[1]?.init?.body)).codeVerifier;
      expect(NodeCrypto.createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
      expect(f.values.size).toBe(1);
      expect([...f.values.keys()][0]).not.toContain("local-a");
      expect(yield* account.getStatus("local-b")).toMatchObject({ status: "signed-out" });
      expect(yield* account.getStatus("local-a")).toMatchObject({ status: "signed-in", profile });
      expect(f.calls.at(-1)?.url).toBe(`${serviceUrl}/v1/me`);
      expect(f.calls.at(-1)?.init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      for (const call of f.calls) {
        expect(call.init?.redirect).toBe("error");
        expect(call.init?.credentials).toBe("omit");
      }
      yield* account.signOut("local-a");
      expect(f.values.size).toBe(0);
      expect(f.calls.at(-1)?.url).toBe(`${serviceUrl}/v1/logout`);
    }),
  );

  it.effect.each([
    "https://attacker.example.test/login",
    `${serviceUrl}/other`,
    `${serviceUrl}/login?requestId=${requestId}&redirect=https://attacker.example.test`,
  ])("rejects an unexpected verification URL: %s", (verificationUrl) =>
    Effect.gen(function* () {
      const f = fixture({
        fetch: async () => Response.json({ ...f.startResponse(), verificationUrl }),
      });
      const account = yield* f.make;
      expect((yield* Effect.flip(account.startLogin("a"))).code).toBe("invalid_response");
      expect(yield* account.getStatus("a")).toMatchObject({ status: "signed-out" });
    }),
  );

  it.effect("does not forward upstream error bodies or malformed profiles", () =>
    Effect.gen(function* () {
      const f = fixture({
        fetch: async () => Response.json({ accessToken: token, profile: { email: profile.email } }),
      });
      const account = yield* f.make;
      const failure = yield* Effect.flip(account.startLogin("a"));
      expect(failure.code).toBe("invalid_response");
      expect(encodeUnknown(failure)).not.toContain(token);
      expect(f.values.size).toBe(0);
    }),
  );

  it.effect("clears expired or remotely revoked sessions without a false signed-in state", () =>
    Effect.gen(function* () {
      const f = fixture({
        fetch: async (input, init) => {
          if (String(input).endsWith("/v1/me")) return new Response(null, { status: 401 });
          return f.defaultFetch(input, init);
        },
      });
      const account = yield* f.make;
      yield* account.startLogin("a");
      f.advance(2);
      yield* account.pollLogin("a");
      expect(yield* account.getStatus("a")).toMatchObject({ status: "signed-out" });
      expect(f.values.size).toBe(0);
      yield* account.startLogin("a");
      f.advance(601);
      expect((yield* Effect.flip(account.pollLogin("a"))).code).toBe("login_expired");
    }),
  );

  it.effect(
    "retains the encrypted credential when remote sign-out fails so revocation can be retried",
    () =>
      Effect.gen(function* () {
        let unavailable = true;
        const f = fixture({
          fetch: async (input, init) => {
            if (String(input).endsWith("/v1/logout") && unavailable)
              throw new Error(`Network failure ${token}`);
            return f.defaultFetch(input, init);
          },
        });
        const account = yield* f.make;
        yield* account.startLogin("a");
        f.advance(2);
        yield* account.pollLogin("a");
        const failure = yield* Effect.flip(account.signOut("a"));
        expect(failure.code).toBe("unavailable");
        expect(encodeUnknown(failure)).not.toContain(token);
        expect(f.values.size).toBe(1);
        unavailable = false;
        expect(yield* account.signOut("a")).toMatchObject({ status: "signed-out" });
        expect(f.values.size).toBe(0);
      }),
  );

  it.effect("cancels starts waiting on credential reads or queued behind them", () =>
    Effect.gen(function* () {
      let releaseRead!: () => void;
      let markReading!: () => void;
      const reading = new Promise<void>((resolve) => {
        markReading = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const f = fixture({
        beforeRead: Effect.promise(async () => {
          markReading();
          await gate;
        }),
      });
      const account = yield* f.make;
      const first = yield* Effect.forkChild(account.startLogin("a"));
      yield* Effect.promise(() => reading);
      const queued = yield* Effect.forkChild(account.startLogin("a"));
      yield* Effect.yieldNow;
      const cancelling = yield* Effect.forkChild(account.signOut("a"));
      yield* Effect.yieldNow;
      releaseRead();
      expect((yield* Fiber.join(first)).status).toBe("signed-out");
      expect((yield* Fiber.join(queued)).status).toBe("signed-out");
      expect((yield* Fiber.join(cancelling)).status).toBe("signed-out");
      expect((yield* account.getStatus("a")).status).toBe("signed-out");
      expect((yield* account.pollLogin("a")).status).toBe("signed-out");
      expect(f.calls).toHaveLength(0);
      expect((yield* account.startLogin("a")).status).toBe("pending");
    }),
  );

  it.effect("discards a broker start response that arrives after cancellation", () =>
    Effect.gen(function* () {
      let finish!: (value: Response) => void;
      let markRequested!: () => void;
      const response = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      const f = fixture({
        fetch: async () => {
          markRequested();
          return response;
        },
      });
      const account = yield* f.make;
      const starting = yield* Effect.forkChild(account.startLogin("a"));
      yield* Effect.promise(() => requested);
      const cancelling = yield* Effect.forkChild(account.signOut("a"));
      yield* Effect.yieldNow;
      finish(Response.json(f.startResponse()));
      expect((yield* Fiber.join(starting)).status).toBe("signed-out");
      expect((yield* Fiber.join(cancelling)).status).toBe("signed-out");
      f.advance(2);
      expect((yield* account.pollLogin("a")).status).toBe("signed-out");
      expect(f.calls).toHaveLength(1);
    }),
  );

  it.effect("revokes a successful late poll after sign-out without resurrecting its identity", () =>
    Effect.gen(function* () {
      let resolveResponse!: (value: Response) => void;
      let markRequested!: () => void;
      const response = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        markRequested = resolve;
      });
      const f = fixture({
        fetch: async (input, init) => {
          if (String(input).endsWith("/v1/login/token")) {
            markRequested();
            return response;
          }
          return f.defaultFetch(input, init);
        },
      });
      const account = yield* f.make;
      yield* account.startLogin("a");
      f.advance(2);
      const polling = yield* Effect.forkChild(account.pollLogin("a"));
      yield* Effect.promise(() => requested);
      const signingOut = yield* Effect.forkChild(account.signOut("a"));
      yield* Effect.yieldNow;
      resolveResponse(Response.json(f.credential()));
      expect(yield* Fiber.join(polling)).toMatchObject({ status: "signed-out", profile: null });
      expect(yield* Fiber.join(signingOut)).toMatchObject({ status: "signed-out", profile: null });
      expect(f.values.size).toBe(0);
      expect(f.calls.filter(({ url }) => url.endsWith("/v1/logout"))).toHaveLength(1);
    }),
  );

  it.effect(
    "reconnects the same local session using its protected stored token, without sharing it",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const first = yield* f.make;
        yield* first.startLogin("a");
        f.advance(2);
        yield* first.pollLogin("a");
        const restarted = yield* f.make;
        expect(yield* restarted.getStatus("a")).toMatchObject({ status: "signed-in", profile });
        expect(yield* restarted.getStatus("b")).toMatchObject({ status: "signed-out" });
      }),
  );

  it.effect(
    "retains a late login credential when cancellation revocation fails, then retries",
    () =>
      Effect.gen(function* () {
        let resolveResponse!: (value: Response) => void;
        let markRequested!: () => void;
        let revokeUnavailable = true;
        const response = new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        });
        const requested = new Promise<void>((resolve) => {
          markRequested = resolve;
        });
        const f = fixture({
          fetch: async (input, init) => {
            if (String(input).endsWith("/v1/login/token")) {
              markRequested();
              return response;
            }
            if (String(input).endsWith("/v1/logout") && revokeUnavailable)
              return new Response(null, { status: 403 });
            return f.defaultFetch(input, init);
          },
        });
        const account = yield* f.make;
        yield* account.startLogin("a");
        f.advance(2);
        const polling = yield* Effect.forkChild(Effect.flip(account.pollLogin("a")));
        yield* Effect.promise(() => requested);
        const signingOut = yield* Effect.forkChild(Effect.flip(account.signOut("a")));
        yield* Effect.yieldNow;
        resolveResponse(Response.json(f.credential()));
        expect((yield* Fiber.join(polling)).code).toBe("request_rejected");
        expect((yield* Fiber.join(signingOut)).code).toBe("request_rejected");
        expect(f.values.size).toBe(1);
        revokeUnavailable = false;
        expect(yield* account.signOut("a")).toMatchObject({ status: "signed-out", profile: null });
        expect(f.values.size).toBe(0);
      }),
  );
});

describe("account session renewal", () => {
  function renewableFixture(mode: "ok" | "offline" | "revoked" | "wrong-user" = "ok") {
    let expiresAt = 1_800_003_602;
    const renewalExpiresAt = 1_802_592_002;
    const renewalToken = "z".repeat(43);
    let failure = mode;
    const f = fixture({
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/login/token")
          return Response.json({
            accessToken: token,
            profile,
            expiresAt,
            renewalToken,
            renewalExpiresAt,
          });
        if (path === "/v1/session/refresh") {
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${renewalToken}`);
          if (failure === "offline") throw new Error("Network unavailable");
          if (failure === "revoked") return new Response(null, { status: 401 });
          expiresAt += 3600;
          return Response.json({
            accessToken: "renewed-synthetic-token",
            profile: failure === "wrong-user" ? { ...profile, subject: "other-user" } : profile,
            expiresAt,
            renewalExpiresAt,
          });
        }
        if (path === "/v1/me") return Response.json({ profile, expiresAt, renewalExpiresAt });
        return f.defaultFetch(input, init);
      },
    });
    return {
      ...f,
      recover: () => {
        failure = "ok";
      },
    };
  }
  it.effect("renews in the backend without an open account panel and stops after sign-out", () =>
    Effect.gen(function* () {
      const f = renewableFixture();
      const account = yield* f.make;
      yield* account.startLogin("a");
      f.advance(2);
      yield* account.pollLogin("a");
      f.advance(3500);
      yield* TestClock.adjust("61 seconds");
      expect(f.calls.filter((c) => c.url.endsWith("/v1/session/refresh"))).toHaveLength(1);
      yield* account.signOut("a");
      f.advance(3600);
      yield* TestClock.adjust("61 seconds");
      expect(f.calls.filter((c) => c.url.endsWith("/v1/session/refresh"))).toHaveLength(1);
    }),
  );
  it.effect(
    "renews expired access on demand after restarting the backend, without exposing credentials",
    () =>
      Effect.gen(function* () {
        const f = renewableFixture();
        const account = yield* f.make;
        yield* account.startLogin("a");
        f.advance(2);
        yield* account.pollLogin("a");
        f.advance(3601);
        const restarted = yield* f.make;
        const status = yield* restarted.getStatus("a");
        expect(status).toMatchObject({
          status: "signed-in",
          expiresAt: 1_800_007_202,
          renewalExpiresAt: 1_802_592_002,
        });
        expect(encodeUnknown(status)).not.toContain("z".repeat(43));
        expect(f.calls.filter((c) => c.url.endsWith("/v1/login/start"))).toHaveLength(1);
        yield* restarted.signOut("a");
        expect(f.values.size).toBe(0);
      }),
  );
  it.effect("keeps renewal credentials through a network outage and retries successfully", () =>
    Effect.gen(function* () {
      const f = renewableFixture("offline");
      const account = yield* f.make;
      yield* account.startLogin("a");
      f.advance(2);
      yield* account.pollLogin("a");
      f.advance(3601);
      expect((yield* Effect.flip(account.getStatus("a"))).code).toBe("unavailable");
      expect(f.values.size).toBe(1);
      f.recover();
      expect((yield* account.getStatus("a")).status).toBe("signed-in");
    }),
  );
  it.effect("requires browser sign-in after campus revocation and rejects changed identities", () =>
    Effect.gen(function* () {
      for (const mode of ["revoked", "wrong-user"] as const) {
        const f = renewableFixture(mode);
        const account = yield* f.make;
        yield* account.startLogin("a");
        f.advance(2);
        yield* account.pollLogin("a");
        f.advance(3601);
        if (mode === "revoked") {
          expect((yield* account.getStatus("a")).status).toBe("signed-out");
          expect(f.values.size).toBe(0);
        } else expect((yield* Effect.flip(account.getStatus("a"))).code).toBe("invalid_response");
      }
    }),
  );
});

describe("Teams account proxy", () => {
  it.effect("uses only the owning environment session's campus credential", () =>
    Effect.gen(function* () {
      let teamRequests = 0;
      const f = fixture({
        fetch: async (input, init) => {
          if (String(input).endsWith("/v1/teams")) {
            teamRequests++;
            expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
            expect(init?.redirect).toBe("error");
            return Response.json({ teams: [], invitations: [], team: null, invitationCode: null });
          }
          return f.defaultFetch(input, init);
        },
      });
      const account = yield* f.make;
      yield* account.startLogin("owner-session");
      f.advance(5);
      yield* account.pollLogin("owner-session");
      expect((yield* Effect.flip(account.teams("another-session", { action: "list" }))).code).toBe(
        "sign_in_required",
      );
      expect(teamRequests).toBe(0);
      expect((yield* account.teams("owner-session", { action: "list" })).teams).toEqual([]);
      expect(teamRequests).toBe(1);
      yield* account.signOut("owner-session");
      expect((yield* Effect.flip(account.teams("owner-session", { action: "list" }))).code).toBe(
        "sign_in_required",
      );
      expect(teamRequests).toBe(1);
    }),
  );
  it.effect("rejects an expired campus session before contacting team storage", () =>
    Effect.gen(function* () {
      const f = fixture();
      const account = yield* f.make;
      yield* account.startLogin("owner-session");
      f.advance(5);
      yield* account.pollLogin("owner-session");
      f.advance(3601);
      expect((yield* Effect.flip(account.teams("owner-session", { action: "list" }))).code).toBe(
        "sign_in_required",
      );
      expect(f.calls.some((call) => call.url.endsWith("/v1/teams"))).toBe(false);
    }),
  );
});
