import { describe, expect, it } from "@effect/vitest";
import type { AccountStatus, TeamsResult } from "@t3tools/contracts";
import { TeamsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { AccountService } from "../auth/AccountService.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as TeamStorage from "./TeamStorageService.ts";

const teamId = "11111111-1111-4111-a111-111111111111";
const config = { clientId: teamId, tenantId: "22222222-2222-4222-a222-222222222222" };
// The main Harness Microsoft app, which the Microsoft 365 plugin signs in to.
const directoryConfig = { ...config, clientId: "33333333-3333-4333-a333-333333333333" };
function fixture() {
  let signedIn = true;
  let member = true;
  let revokeDuringList = false;
  let continuation = false;
  let moveFolder = false;
  let folderListed = false;
  let microsoftUnavailable = false;
  let demoteOnGraph = false;
  let switchAccountOnGraph = false;
  let subject = "alice";
  let teamOverride: Partial<NonNullable<TeamsResult["team"]>> = {};
  let directory: { status: number; body: unknown } = { status: 200, body: { value: [] } };
  const directoryRequests: { url: URL; token: string | undefined }[] = [];
  const tokenForms: URLSearchParams[] = [];
  let me = { id: "alice-object", userPrincipalName: "alice@ucsd.edu", userType: "Member" };
  let onDirectory = () => {};
  const graphWrites: string[] = [];
  const values = new Map<string, Uint8Array>();
  const graphRequests: string[] = [];
  const status = (): AccountStatus => ({
    configured: true,
    status: signedIn ? "signed-in" : "signed-out",
    serviceUrl: "https://accounts.example.test",
    profile: signedIn
      ? {
          issuer: "https://campus.example.test",
          subject,
          email: "alice@ucsd.edu",
          displayName: "Alice",
        }
      : null,
    expiresAt: 1800000000,
    verificationUrl: null,
    userCode: null,
    pollIntervalSeconds: null,
  });
  const teams: TeamsResult = {
    teams: [],
    invitations: [],
    invitationCode: null,
    team: {
      id: teamId,
      reference: "T-12345678",
      name: "Synthetic",
      role: "owner",
      canManage: true,
      revision: 2,
      state: "ready",
      members: [],
      invitations: [],
      storage: { tenantId: config.tenantId, siteId: "site", driveId: "drive", folderId: "root" },
    },
  };
  const account = AccountService.of({
    getStatus: () => Effect.sync(status),
    startLogin: () => Effect.sync(status),
    pollLogin: () => Effect.sync(status),
    signOut: () =>
      Effect.sync(() => {
        signedIn = false;
        return status();
      }),
    teams: () =>
      Effect.suspend(() =>
        member
          ? Effect.succeed({ ...teams, team: { ...teams.team!, ...teamOverride } })
          : Effect.fail(new TeamsError({ code: "not_found", message: "Team unavailable" })),
      ),
  });
  const secrets = ServerSecretStore.of({
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
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      if (microsoftUnavailable && path.endsWith("/me"))
        return HttpClientResponse.fromWeb(request, Response.json({}, { status: 429 }));
      if (path === "/v1.0/users") {
        directoryRequests.push({ url: new URL(request.url), token: request.headers.authorization });
        onDirectory();
        return HttpClientResponse.fromWeb(
          request,
          Response.json(directory.body, { status: directory.status }),
        );
      }
      if (path.includes("/drives/")) {
        graphRequests.push(request.url);
        if (request.method !== "GET") graphWrites.push(`${request.method} ${request.url}`);
        // A concurrent owner action demotes the caller after the operation has started.
        if (demoteOnGraph) teamOverride = { role: "reader", canManage: false, revision: 3 };
        // Another campus account takes over the session while a listing is in flight.
        if (switchAccountOnGraph) subject = "mallory";
      }
      if (moveFolder && path.includes("/drives/")) {
        if (path.endsWith("/items/root/children"))
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              value: [
                { id: "nested", name: "Nested", parentReference: { id: "root" }, folder: {} },
              ],
            }),
          );
        if (path.endsWith("/items/root:/Nested:/children")) {
          folderListed = true;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              value: [
                {
                  id: "file",
                  name: "summary.md",
                  parentReference: { id: "nested" },
                  file: {},
                  eTag: "v1",
                  size: 1,
                },
              ],
            }),
          );
        }
        if (path.endsWith("/items/root:/Nested"))
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: folderListed ? "replacement" : "nested",
              name: "Nested",
              parentReference: { id: "root" },
              folder: {},
            }),
          );
      }
      const body = path.endsWith("/devicecode")
        ? {
            device_code: "synthetic-device-secret",
            user_code: "SYNTHETIC",
            verification_uri: "https://microsoft.com/devicelogin",
            expires_in: 600,
            interval: 5,
          }
        : path.endsWith("/token")
          ? {
              // The main Harness app's tokens are told apart from the Teams storage app's.
              access_token:
                tokenForm(request)?.get("client_id") === directoryConfig.clientId
                  ? "synthetic-directory-token"
                  : "synthetic-graph-token",
              refresh_token: "synthetic-refresh-token",
              expires_in: 3600,
            }
          : path.endsWith("/me")
            ? me
            : path.endsWith("/children")
              ? {
                  value: [
                    {
                      id: "file",
                      name: "summary.md",
                      parentReference: { id: "root" },
                      file: {},
                      eTag: "v1",
                      size: 1,
                    },
                  ],
                  ...(continuation
                    ? { "@odata.nextLink": "https://unrelated.example.test/steal" }
                    : {}),
                }
              : null;
      if (revokeDuringList && path.endsWith("/children")) member = false;
      return HttpClientResponse.fromWeb(request, Response.json(body, { status: body ? 200 : 404 }));
    }),
  );
  const tokenForm = (request: HttpClientRequest.HttpClientRequest) => {
    if (request.body._tag !== "Uint8Array") return null;
    const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
    tokenForms.push(form);
    return form;
  };
  const makeWithDirectory = (directory: typeof config | null) =>
    TeamStorage.make(config, directory).pipe(
      Effect.provideService(AccountService, account),
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  const make = makeWithDirectory(null);
  const connect = (service: TeamStorage.TeamStorageService["Service"], sessionId = "a") =>
    Effect.gen(function* () {
      const flow = yield* service.execute(sessionId, { action: "connect", teamId });
      if (!flow.flowId) throw new Error("Expected synthetic device flow");
      yield* service.execute(sessionId, { action: "poll", teamId, flowId: flow.flowId });
    });
  return {
    make,
    makeWithDirectory,
    connect,
    directoryRequests,
    tokenForms,
    connectPlugin: () =>
      values.set(
        "integration-microsoft-365--oauth",
        new TextEncoder().encode(JSON.stringify({ refreshToken: "plugin-refresh-token" })),
      ),
    setMe: (next: Partial<typeof me>) => {
      me = { ...me, ...next };
    },
    onDirectory: (hook: () => void) => {
      onDirectory = hook;
    },
    setDirectory: (status: number, body: unknown) => {
      directory = { status, body };
    },
    values,
    graphRequests,
    graphWrites,
    setTeam: (override: Partial<NonNullable<TeamsResult["team"]>>) => {
      teamOverride = override;
    },
    demoteOnGraph: () => {
      demoteOnGraph = true;
    },
    switchAccountOnGraph: () => {
      switchAccountOnGraph = true;
    },
    setMicrosoftUnavailable: (value: boolean) => {
      microsoftUnavailable = value;
    },
    moveFolderDuringList: () => {
      moveFolder = true;
    },
    revoke: () => {
      member = false;
    },
    revokeOnList: () => {
      revokeDuringList = true;
    },
    unsafeContinuation: () => {
      continuation = true;
    },
    signIn: () => {
      signedIn = true;
    },
  };
}

describe("Teams storage service boundary", () => {
  it.effect(
    "reports temporary identity outages as retryable without discarding the connection",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const service = yield* f.make;
        yield* f.connect(service);
        const restarted = yield* f.make;
        f.setMicrosoftUnavailable(true);
        expect(
          (yield* Effect.flip(restarted.execute("a", { action: "list-files", teamId }))).code,
        ).toBe("unavailable");
        expect(f.graphRequests).toHaveLength(0);
        f.setMicrosoftUnavailable(false);
        expect(
          (yield* restarted.execute("a", { action: "list-files", teamId })).files,
        ).toHaveLength(1);
      }),
  );
  it.effect(
    "isolates sessions and clears persisted Microsoft credentials on campus sign-out after restart",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const first = yield* f.make;
        yield* f.connect(first);
        expect((yield* first.execute("b", { action: "status", teamId })).status).toBe(
          "disconnected",
        );
        const restarted = yield* f.make;
        yield* restarted.signOutAccount("a");
        expect(
          [...f.values.keys()].filter(
            (key) => key.startsWith("team-microsoft-") && !key.startsWith("team-microsoft-index-"),
          ),
        ).toHaveLength(0);
        expect(
          (yield* Effect.flip(first.execute("a", { action: "list-files", teamId }))).code,
        ).toBe("sign_in_required");
        f.signIn();
        expect((yield* restarted.execute("a", { action: "status", teamId })).status).toBe(
          "disconnected",
        );
      }),
  );
  it.effect("rejects revoked members before Graph and discards lists revoked while in flight", () =>
    Effect.gen(function* () {
      for (const inFlight of [false, true]) {
        const f = fixture();
        const service = yield* f.make;
        yield* f.connect(service);
        if (inFlight) f.revokeOnList();
        else f.revoke();
        expect(
          (yield* Effect.flip(service.execute("a", { action: "list-files", teamId }))).code,
        ).toBe("not_found");
        expect(f.graphRequests.length).toBe(inFlight ? 1 : 0);
      }
    }),
  );
  it.effect("never forwards a bearer to an untrusted file-list continuation", () =>
    Effect.gen(function* () {
      const f = fixture();
      const service = yield* f.make;
      yield* f.connect(service);
      f.unsafeContinuation();
      expect(
        (yield* Effect.flip(service.execute("a", { action: "list-files", teamId }))).code,
      ).toBe("unavailable");
      expect(f.graphRequests).toHaveLength(1);
    }),
  );
});

it.effect("anchors nested listings and discards metadata when a folder moves before return", () =>
  Effect.gen(function* () {
    const f = fixture();
    const service = yield* f.make;
    yield* f.connect(service);
    f.moveFolderDuringList();
    expect(
      (yield* Effect.flip(service.execute("a", { action: "list-files", teamId }))).message,
    ).toContain("folder moved");
    expect(f.graphRequests.some((url) => url.includes("/items/nested/children"))).toBe(false);
    expect(f.graphRequests.some((url) => url.includes("/items/root:/Nested:/children"))).toBe(true);
  }),
);

describe("Teams storage role and team binding", () => {
  const recordId = "33333333-3333-4333-a333-333333333333";
  const deviceId = "44444444-4444-4444-a444-444444444444";
  const publish = {
    action: "publish",
    teamId,
    recordId,
    deviceId,
    kind: "sop",
    title: "Synthetic",
    project: "",
    text: "Synthetic body",
  } as const;
  const path = `SOPs/${"a".repeat(43)}/${deviceId}/${recordId}.md`;

  it.effect("denies every reader write before any Graph request", () =>
    Effect.gen(function* () {
      const f = fixture();
      const service = yield* f.make;
      yield* f.connect(service);
      f.setTeam({ role: "reader", canManage: false });
      for (const command of [
        publish,
        { action: "update-file", teamId, path, etag: "v1", text: "Changed" },
        { action: "delete-file", teamId, path, etag: "v1" },
      ] as const)
        expect((yield* Effect.flip(service.execute("a", command))).code).toBe("forbidden");
      expect(f.graphRequests).toHaveLength(0);
    }),
  );

  it.effect("aborts a write before any Graph mutation when a demotion lands mid-operation", () =>
    Effect.gen(function* () {
      const f = fixture();
      const service = yield* f.make;
      yield* f.connect(service);
      f.demoteOnGraph();
      expect((yield* Effect.flip(service.execute("a", publish))).code).toBe("conflict");
      expect(f.graphRequests.length).toBeGreaterThan(0);
      expect(f.graphWrites).toEqual([]);
    }),
  );

  it.effect("never uses storage from a membership response for a different team", () =>
    Effect.gen(function* () {
      const f = fixture();
      const service = yield* f.make;
      yield* f.connect(service);
      f.setTeam({
        id: "55555555-5555-4555-a555-555555555555",
        storage: { tenantId: config.tenantId, siteId: "site", driveId: "drive", folderId: "other" },
      });
      expect(
        (yield* Effect.flip(service.execute("a", { action: "list-files", teamId }))).code,
      ).toBe("not_found");
      expect(f.graphRequests).toHaveLength(0);
    }),
  );

  it.effect(
    "denies a removed member every storage action, including nested paths, before Graph",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const service = yield* f.make;
        yield* f.connect(service);
        f.revoke();
        for (const command of [
          { action: "status", teamId },
          { action: "connect", teamId },
          { action: "list-files", teamId },
          { action: "read-file", teamId, path: "summary.md" },
          { action: "read-file", teamId, path },
          publish,
          { action: "update-file", teamId, path, etag: "v1", text: "Changed" },
          { action: "delete-file", teamId, path, etag: "v1" },
        ] as const)
          expect((yield* Effect.flip(service.execute("a", command))).code).toBe("not_found");
        expect(f.graphRequests).toHaveLength(0);
      }),
  );

  it.effect("refuses a quarantined or provisioning team before Graph", () =>
    Effect.gen(function* () {
      for (const state of ["needs-attention", "provisioning"] as const) {
        const f = fixture();
        const service = yield* f.make;
        yield* f.connect(service);
        f.setTeam({ state });
        for (const command of [{ action: "list-files", teamId }, publish] as const)
          expect((yield* Effect.flip(service.execute("a", command))).code).toBe("unavailable");
        expect(f.graphRequests).toHaveLength(0);
      }
    }),
  );

  it.effect("discards a listing when the campus account changes mid-operation", () =>
    Effect.gen(function* () {
      const f = fixture();
      const service = yield* f.make;
      yield* f.connect(service);
      f.switchAccountOnGraph();
      expect(
        (yield* Effect.flip(service.execute("a", { action: "list-files", teamId }))).code,
      ).toBe("sign_in_required");
      expect(f.graphRequests).toHaveLength(1);
    }),
  );
});

describe("invitee lookup", () => {
  const lookup = { action: "lookup-invitee", teamId, email: "Bob@UCSD.edu" } as const;
  const person = (upn: string, extra: object = {}) => ({
    id: `${upn}-id`,
    displayName: "Bob Example",
    mail: upn,
    userPrincipalName: upn,
    ...extra,
  });
  const ready = Effect.gen(function* () {
    const f = fixture();
    f.connectPlugin();
    return { f, service: yield* f.makeWithDirectory(directoryConfig) };
  });

  it.effect("is off without the main Microsoft app and never queries the directory", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.connectPlugin();
      const service = yield* f.make;
      expect((yield* service.execute("a", lookup)).invitee).toEqual({
        email: "bob@ucsd.edu",
        status: "off",
      });
      const otherTenant = yield* f.makeWithDirectory({
        ...directoryConfig,
        tenantId: "44444444-4444-4444-a444-444444444444",
      });
      expect((yield* otherTenant.execute("a", lookup)).invitee?.status).toBe("off");
      expect(f.directoryRequests).toHaveLength(0);
      expect(f.tokenForms).toHaveLength(0);
    }),
  );

  it.effect("reads the directory through the plugin sign-in, saving nothing of its own", () =>
    Effect.gen(function* () {
      const { f, service } = yield* ready;
      f.setDirectory(200, { value: [person("bob@ucsd.edu", { mail: null })] });
      // The team storage connection isn't needed and stays disconnected.
      const result = yield* service.execute("a", lookup);
      expect(result.status).toBe("disconnected");
      expect(result.invitee).toEqual({
        email: "bob@ucsd.edu",
        status: "found",
        displayName: "Bob Example",
        userPrincipalName: "bob@ucsd.edu",
        mail: null,
      });
      // The only saved sign-in is still the plugin's; the index lists no credentials.
      expect(
        [...f.values.keys()].filter((key) => !key.startsWith("team-microsoft-index-")),
      ).toEqual(["integration-microsoft-365--oauth"]);
      const form = f.tokenForms.at(-1)!;
      expect(form.get("client_id")).toBe(directoryConfig.clientId);
      expect(form.get("refresh_token")).toBe("plugin-refresh-token");
      expect(form.get("scope")).toBe("User.ReadBasic.All User.Read");
      expect(f.directoryRequests).toHaveLength(1);
      const request = f.directoryRequests[0]!;
      expect(request.token).toBe("Bearer synthetic-directory-token");
      expect(request.url.searchParams.get("$select")).toBe("id,displayName,mail,userPrincipalName");
      expect(request.url.searchParams.get("$filter")).toBe(
        "userPrincipalName eq 'bob@ucsd.edu' or mail eq 'bob@ucsd.edu'",
      );
      yield* service.execute("a", { ...lookup, email: "o'neil@ucsd.edu" });
      expect(f.directoryRequests[1]!.url.searchParams.get("$filter")).toBe(
        "userPrincipalName eq 'o''neil@ucsd.edu' or mail eq 'o''neil@ucsd.edu'",
      );
      // Nothing is cached, so disconnecting the plugin ends lookup at once.
      f.values.delete("integration-microsoft-365--oauth");
      expect((yield* service.execute("a", lookup)).invitee?.status).toBe("connect");
      expect(f.directoryRequests).toHaveLength(2);
    }),
  );

  it.effect("refuses a missing, mismatched, or guest plugin account before the directory", () =>
    Effect.gen(function* () {
      const f = fixture();
      const service = yield* f.makeWithDirectory(directoryConfig);
      expect((yield* service.execute("a", lookup)).invitee?.status).toBe("connect");
      f.connectPlugin();
      f.setMe({ userPrincipalName: "mallory@ucsd.edu" });
      expect((yield* service.execute("a", lookup)).invitee?.status).toBe("mismatch");
      f.setMe({ userPrincipalName: "alice@ucsd.edu", userType: "Guest" });
      expect((yield* service.execute("a", lookup)).invitee?.status).toBe("mismatch");
      expect(f.directoryRequests).toHaveLength(0);
    }),
  );

  it.effect("needs an owner, and drops a result when access changes mid-lookup", () =>
    Effect.gen(function* () {
      const { f, service } = yield* ready;
      f.setTeam({ role: "member", canManage: false });
      expect((yield* Effect.flip(service.execute("a", lookup))).code).toBe("forbidden");
      expect(f.tokenForms).toHaveLength(0);
      f.setTeam({});
      f.setDirectory(200, { value: [person("bob@ucsd.edu")] });
      f.onDirectory(() => f.setTeam({ role: "member", canManage: false, revision: 3 }));
      expect((yield* Effect.flip(service.execute("a", lookup))).code).toBe("conflict");
    }),
  );

  it.effect("refuses missing, ambiguous, guest, and unconsented results", () =>
    Effect.gen(function* () {
      const { f, service } = yield* ready;
      const cases: ReadonlyArray<readonly [number, unknown, string]> = [
        [200, { value: [] }, "not-found"],
        // A result that doesn't carry the typed address isn't the person asked for.
        [200, { value: [person("robert@ucsd.edu")] }, "not-found"],
        [
          200,
          {
            value: [person("bob@ucsd.edu"), person("robert@ucsd.edu", { mail: "bob@ucsd.edu" })],
          },
          "ambiguous",
        ],
        [
          200,
          {
            value: [person("bob_example.com#EXT#@ucsd.onmicrosoft.com", { mail: "bob@ucsd.edu" })],
          },
          "guest",
        ],
        [403, { error: { code: "Authorization_RequestDenied" } }, "not-permitted"],
      ];
      for (const [status, body, expected] of cases) {
        f.setDirectory(status, body);
        expect((yield* service.execute("a", lookup)).invitee?.status).toBe(expected);
      }
      f.setDirectory(503, {});
      expect((yield* Effect.flip(service.execute("a", lookup))).code).toBe("unavailable");
    }),
  );
});
