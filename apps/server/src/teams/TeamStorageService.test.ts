import { describe, expect, it } from "@effect/vitest";
import type { AccountStatus, TeamsResult } from "@t3tools/contracts";
import { TeamsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { AccountService } from "../auth/AccountService.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as TeamStorage from "./TeamStorageService.ts";

const teamId = "11111111-1111-4111-a111-111111111111";
const config = { clientId: teamId, tenantId: "22222222-2222-4222-a222-222222222222" };
function fixture() {
  let signedIn = true;
  let member = true;
  let revokeDuringList = false;
  let continuation = false;
  let moveFolder = false;
  let folderListed = false;
  let microsoftUnavailable = false;
  let demoteOnGraph = false;
  let teamOverride: Partial<NonNullable<TeamsResult["team"]>> = {};
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
          subject: "alice",
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
      if (path.includes("/drives/")) {
        graphRequests.push(request.url);
        if (request.method !== "GET") graphWrites.push(`${request.method} ${request.url}`);
        // A concurrent owner action demotes the caller after the operation has started.
        if (demoteOnGraph) teamOverride = { role: "reader", canManage: false, revision: 3 };
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
              access_token: "synthetic-graph-token",
              refresh_token: "synthetic-refresh-token",
              expires_in: 3600,
            }
          : path.endsWith("/me")
            ? {
                id: "alice-object",
                userPrincipalName: "alice@ucsd.edu",
                userType: "Member",
              }
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
  const make = TeamStorage.make(config).pipe(
    Effect.provideService(AccountService, account),
    Effect.provideService(ServerSecretStore, secrets),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const connect = (service: TeamStorage.TeamStorageService["Service"], sessionId = "a") =>
    Effect.gen(function* () {
      const flow = yield* service.execute(sessionId, { action: "connect", teamId });
      if (!flow.flowId) throw new Error("Expected synthetic device flow");
      yield* service.execute(sessionId, { action: "poll", teamId, flowId: flow.flowId });
    });
  return {
    make,
    connect,
    values,
    graphRequests,
    graphWrites,
    setTeam: (override: Partial<NonNullable<TeamsResult["team"]>>) => {
      teamOverride = override;
    },
    demoteOnGraph: () => {
      demoteOnGraph = true;
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
});
