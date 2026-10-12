import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { make } from "../memory/sync/microsoftSignIn.ts";

const oauth = {
  clientId: "11111111-1111-4111-a111-111111111111",
  tenantId: "22222222-2222-4222-a222-222222222222",
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
function fixture() {
  const values = new Map<string, Uint8Array>();
  const reads: string[] = [];
  let email = "alice@ucsd.edu";
  let oid = "alice-object";
  let userType = "Member";
  let identityStatus = 200;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/me") && identityStatus !== 200)
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ error: "temporary" }, { status: identityStatus }),
        );
      const body = path.endsWith("devicecode")
        ? {
            device_code: "device-secret",
            user_code: "TEST-CODE",
            verification_uri: "https://microsoft.com/devicelogin",
            expires_in: 600,
            interval: 5,
          }
        : path.endsWith("token")
          ? { access_token: "graph-token", refresh_token: "refresh-token", expires_in: 3600 }
          : path.endsWith("/me")
            ? { id: oid, userPrincipalName: email, mail: email, userType }
            : null;
      return HttpClientResponse.fromWeb(request, Response.json(body, { status: body ? 200 : 404 }));
    }),
  );
  const secrets = ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        reads.push(name);
        return Option.fromNullishOr(values.get(name));
      }),
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
  });
  return {
    values,
    reads,
    setIdentityStatus: (status: number) => {
      identityStatus = status;
    },
    setIdentity: (next: { email?: string; oid?: string; userType?: string }) => {
      email = next.email ?? email;
      oid = next.oid ?? oid;
      userType = next.userType ?? userType;
    },
    connect: (secretName = "team-alice") =>
      make(oauth, {
        secretName,
        scopes: "Sites.Selected User.Read offline_access",
        requiredAccount: { email: "alice@ucsd.edu", tenantId: oauth.tenantId },
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(ServerSecretStore, secrets),
      ),
  };
}
describe("account-bound team Microsoft connection", () => {
  it.effect("never borrows a personal plugin token and isolates browser session namespaces", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.values.set(
        "integration-microsoft-365--oauth",
        new TextEncoder().encode(encode({ refreshToken: "personal-token" })),
      );
      const first = yield* f.connect();
      expect((yield* Effect.flip(first.accessToken))._tag).toBe("MemorySyncSignInRequired");
      expect(f.reads).not.toContain("integration-microsoft-365--oauth");
      const flow = yield* first.start(Effect.void);
      if (flow.kind !== "device_code") throw new Error("Expected device-code sign-in");
      expect((yield* first.pollDeviceCode(flow.flowId, Effect.void)).state).toBe("connected");
      const second = yield* f.connect("team-other-session");
      expect(yield* second.account).toBeNull();
      expect((yield* Effect.flip(second.accessToken))._tag).toBe("MemorySyncSignInRequired");
      expect(yield* first.accessToken).toBe("graph-token");
    }),
  );
  it.effect("rejects a wrong Microsoft account and a guest before saving credentials", () =>
    Effect.gen(function* () {
      for (const identity of [{ email: "bob@ucsd.edu" }, { userType: "Guest" }]) {
        const f = fixture();
        f.setIdentity(identity);
        const connection = yield* f.connect();
        const flow = yield* connection.start(Effect.void);
        if (flow.kind !== "device_code") throw new Error("Expected device-code sign-in");
        expect(
          (yield* Effect.flip(connection.pollDeviceCode(flow.flowId, Effect.void))).message,
        ).toContain("matches your UC San Diego account");
        expect(f.values.size).toBe(0);
        expect(yield* connection.account).toBeNull();
      }
    }),
  );
  it.effect("rechecks object identity on refresh and drops a reassigned account", () =>
    Effect.gen(function* () {
      const f = fixture();
      const connection = yield* f.connect();
      const flow = yield* connection.start(Effect.void);
      if (flow.kind !== "device_code") throw new Error("Expected device-code sign-in");
      yield* connection.pollDeviceCode(flow.flowId, Effect.void);
      f.setIdentity({ oid: "different-directory-object" });
      yield* connection.invalidateAccessToken;
      expect((yield* Effect.flip(connection.accessToken)).message).toContain(
        "matches your UC San Diego account",
      );
      expect(f.values.has("team-alice")).toBe(false);
    }),
  );
});

it.effect("preserves the saved connection through a transient Microsoft identity outage", () =>
  Effect.gen(function* () {
    const f = fixture();
    const connection = yield* f.connect();
    const flow = yield* connection.start(Effect.void);
    if (flow.kind !== "device_code") throw new Error("Expected device-code sign-in");
    yield* connection.pollDeviceCode(flow.flowId, Effect.void);
    yield* connection.invalidateAccessToken;
    f.setIdentityStatus(429);
    expect((yield* Effect.flip(connection.accessToken)).message).toContain("Try again shortly");
    expect(f.values.has("team-alice")).toBe(true);
    f.setIdentityStatus(200);
    expect(yield* connection.accessToken).toBe("graph-token");
  }),
);
