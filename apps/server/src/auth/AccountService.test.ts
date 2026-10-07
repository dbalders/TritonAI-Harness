import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { make, resolveAccountServiceUrl } from "./AccountService.ts";
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
}) {
  const values = new Map<string, Uint8Array>();
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let time = 1_800_000_000;
  const store: ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
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
    calls,
    startResponse,
    credential,
    defaultFetch,
    advance: (seconds: number) => {
      time += seconds;
    },
    make: make({
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
  it.effect(
    "waits for the owning desktop callback rather than exchanging on a background poll",
    () =>
      Effect.gen(function* () {
        const returnUrl = `http://127.0.0.1:45123/account/callback/${"c".repeat(43)}`;
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
    expect(resolveAccountServiceUrl("")).toBeNull();
    expect(resolveAccountServiceUrl(`${serviceUrl}/`)).toBe(serviceUrl);
    expect(resolveAccountServiceUrl("http://127.0.0.1:8788", true)).toBe("http://127.0.0.1:8788");
    for (const value of [
      "http://127.0.0.1:8788",
      "http://accounts.example.test",
      "https://user:pass@accounts.example.test",
      `${serviceUrl}/untrusted/path`,
      `${serviceUrl}?override=1`,
      `${serviceUrl}#fragment`,
    ])
      expect(() => resolveAccountServiceUrl(value)).toThrow();
    expect(() => resolveAccountServiceUrl("http://accounts.example.test", true)).toThrow();
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
