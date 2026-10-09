import { describe, expect, it } from "@effect/vitest";
import {
  type AccountStatus,
  formatTeamNote,
  ProjectId,
  ThreadId,
  type TeamRole,
  type TeamStorage as TeamStorageRecord,
  TeamsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { AccountService } from "../auth/AccountService.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TeamProject from "./TeamProjectService.ts";
import * as TeamStorage from "./TeamStorageService.ts";

const teamA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const teamB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const tenantId = "22222222-2222-4222-a222-222222222222";
const config = { clientId: "11111111-1111-4111-a111-111111111111", tenantId };
const projectId = ProjectId.make("project-a");
const otherProject = ProjectId.make("project-personal");
const recordId = "33333333-3333-4333-a333-333333333333";
const deviceId = "44444444-4444-4444-a444-444444444444";
const threadId = ThreadId.make("thread-a");

function fixture() {
  let subject = "alice";
  let signedIn = true;
  const roles: Record<string, Record<string, TeamRole>> = {
    [teamA]: { alice: "editor" },
    [teamB]: { mallory: "owner" },
  };
  const storage: Record<string, TeamStorageRecord> = {
    [teamA]: { tenantId, siteId: "ucsd.sharepoint.com,site", driveId: "driveA", folderId: "rootA" },
    [teamB]: { tenantId, siteId: "ucsd.sharepoint.com,site", driveId: "driveB", folderId: "rootB" },
  };
  const projects = new Map([
    [projectId, "Grant reports"],
    [otherProject, "Personal notes"],
  ]);
  const threads = new Map([[threadId, projectId]]);
  const values = new Map<string, Uint8Array>();
  const graph: string[] = [];
  // Runs once, inside the next Graph request, to interleave another call with an in-flight one.
  let duringGraph: Effect.Effect<unknown, TeamsError> | null = null;
  const writes: { method: string; url: string; body: string }[] = [];
  const status = (): AccountStatus => ({
    configured: true,
    status: signedIn ? "signed-in" : "signed-out",
    serviceUrl: "https://accounts.example.test",
    profile: signedIn
      ? {
          issuer: "https://campus.example.test",
          subject,
          email: `${subject}@ucsd.edu`,
          displayName: subject,
        }
      : null,
    expiresAt: 1800000000,
    verificationUrl: null,
    userCode: null,
    pollIntervalSeconds: null,
  });
  const account = AccountService.of({
    getStatus: () => Effect.sync(status),
    startLogin: () => Effect.sync(status),
    pollLogin: () => Effect.sync(status),
    signOut: () => Effect.sync(status),
    teams: (_sessionId, command) =>
      Effect.suspend(() => {
        const teamId = "teamId" in command ? command.teamId : "";
        const role = signedIn ? roles[teamId]?.[subject] : undefined;
        if (!role)
          return Effect.fail(new TeamsError({ code: "not_found", message: "Team unavailable" }));
        return Effect.succeed({
          teams: [],
          invitations: [],
          invitationCode: null,
          team: {
            id: teamId,
            reference: "T-12345678",
            name: teamId === teamA ? "Team A" : "Team B",
            role,
            canManage: role === "owner",
            revision: 1,
            state: "ready" as const,
            members: [],
            invitations: [],
            storage: storage[teamId]!,
          },
        });
      }),
  });
  const secrets = ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
  });
  const shell = (id: ProjectId, title: string) => ({
    id,
    title,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:00:00.000Z",
  });
  const unused = () => Effect.die("unused");
  const query = ProjectionSnapshotQuery.of({
    getUserInputActivity: unused,
    listActivitiesByKind: unused,
    getCommandReadModel: unused,
    getSnapshot: unused,
    getShellSnapshot: unused,
    getDeletedWorktreeThreads: unused,
    listThreadsWithPullRequests: unused,
    getArchivedShellSnapshot: unused,
    getSnapshotSequence: unused,
    getCounts: unused,
    getEventReplayStats: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShells: unused,
    getProjectShellById: (id) =>
      Effect.sync(() => {
        const title = projects.get(id);
        return title ? Option.some(shell(id, title)) : Option.none();
      }),
    getFirstActiveThreadIdByProjectId: unused,
    getImportedAgentSessionSources: unused,
    getThreadCheckpointContext: unused,
    getFullThreadDiffContext: unused,
    getThreadRuntimeContext: unused,
    getTurnStartMessage: unused,
    getThreadShellById: (id) =>
      Effect.sync(() => {
        const owner = threads.get(id);
        return owner
          ? Option.some({ id, projectId: owner } as unknown as OrchestrationThreadShell)
          : Option.none();
      }),
    getThreadDetailById: unused,
    getThreadDetailSnapshot: unused,
    searchThreads: unused,
  });
  // Synthetic Graph: every item id is "<root>:<path>", so a response always names its own root.
  const graphPath =
    /^\/v1\.0\/drives\/([^/]+)\/items\/([^:/]+)(?::\/(.*?))?(:\/children|:\/content|\/children)?$/u;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      if (
        duringGraph &&
        url.hostname === "graph.microsoft.com" &&
        url.pathname.includes("/items/")
      ) {
        const interleaved = duringGraph;
        duringGraph = null;
        yield* Effect.ignore(interleaved);
      }
      const json = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      if (url.pathname.endsWith("/devicecode"))
        return json({
          device_code: "synthetic-device-secret",
          user_code: "SYNTHETIC",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 600,
          interval: 5,
        });
      if (url.pathname.endsWith("/token"))
        return json({
          access_token: "synthetic-graph-token",
          refresh_token: "synthetic-refresh-token",
          expires_in: 3600,
        });
      if (url.pathname.endsWith("/me"))
        return json({
          id: `${subject}-object`,
          userPrincipalName: `${subject}@ucsd.edu`,
          userType: "Member",
        });
      if (url.hostname === "ucsd.sharepoint.com")
        return HttpClientResponse.fromWeb(
          request,
          new Response(`Shared note from ${url.pathname.slice(1)}`),
        );
      const match = graphPath.exec(url.pathname);
      if (!match) return json(null, 404);
      graph.push(`${request.method} ${request.url}`);
      const [, , root, encoded = "", suffix] = match;
      const path = decodeURIComponent(encoded);
      const parts = path ? path.split("/") : [];
      const id = (segments: string[]) => (segments.length ? `${root}:${segments.join("/")}` : root);
      const item = (segments: string[], file: boolean) => ({
        id: id(segments),
        name: segments.at(-1),
        parentReference: { id: id(segments.slice(0, -1)) },
        ...(file
          ? {
              file: {},
              eTag: "v1",
              size: 10,
              "@microsoft.graph.downloadUrl": `https://ucsd.sharepoint.com/${id(segments)}`,
            }
          : { folder: {} }),
      });
      if (request.method === "PUT" && suffix === ":/content") {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        writes.push({ method: "PUT", url: request.url, body });
        return json(item(parts, true), 201);
      }
      if (request.method !== "GET") {
        writes.push({ method: request.method, url: request.url, body: "" });
        return json(null, 404);
      }
      if (suffix?.endsWith("children"))
        return json({
          value: path === "Memory" ? [{ ...item([...parts, "note.md"], true) }] : [],
        });
      return json(item(parts, path.endsWith(".md")));
    }),
  );
  const make = Effect.gen(function* () {
    const storageService = yield* TeamStorage.make(config).pipe(
      Effect.provideService(AccountService, account),
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const service = yield* TeamProject.make.pipe(
      Effect.provideService(AccountService, account),
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.provideService(TeamStorage.TeamStorageService, storageService),
    );
    // Microsoft connection is per campus identity, as in the Teams page.
    const connect = (teamId: string) =>
      Effect.gen(function* () {
        const flow = yield* storageService.execute("s", { action: "connect", teamId });
        yield* storageService.execute("s", { action: "poll", teamId, flowId: flow.flowId! });
      });
    return { service, connect };
  });
  return {
    make,
    graph,
    writes,
    roles,
    storage,
    projects,
    threads,
    values,
    interleave: (effect: Effect.Effect<unknown, TeamsError>) => {
      duringGraph = effect;
    },
    switchTo: (next: string) => {
      subject = next;
    },
    signOut: () => {
      signedIn = false;
    },
  };
}

const code = <A>(effect: Effect.Effect<A, TeamsError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code));

describe("Team project memory", () => {
  it.effect("reads and publishes only the linked team's memory with project provenance", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      const linked = yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      expect(linked.projects).toEqual([
        expect.objectContaining({ projectId, projectTitle: "Grant reports", teamId: teamA }),
      ]);
      f.graph.length = 0;
      const listed = yield* service.execute("s", { action: "memory-list", projectId });
      expect(listed.storage?.files.map((file) => file.path)).toEqual(["Memory/note.md"]);
      // Listing stays inside team A's Memory folder.
      expect(f.graph.length).toBeGreaterThan(0);
      for (const request of f.graph)
        expect(request).toContain("/drives/driveA/items/rootA:/Memory");
      const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
      const read = yield* service.execute("s", { action: "memory-read", projectId, path });
      expect(read.storage?.document?.text).toBe(`Shared note from rootA:${path}`);
      yield* service.execute("s", {
        action: "memory-publish",
        projectId,
        recordId,
        deviceId,
        title: "Weekly summary",
        text: "Filed the report.",
      });
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]!.url).toContain(`/drives/driveA/items/rootA:/Memory/`);
      expect(f.writes[0]!.url).toContain(`/${deviceId}/${recordId}.md:/content`);
      expect(f.writes[0]!.body).toBe(
        "# Weekly summary\n\nProject: Grant reports\n\nFiled the report.",
      );
      expect(f.graph.some((request) => request.includes("rootB"))).toBe(false);
    }),
  );

  it.effect("cannot link or retarget a project to a team the caller cannot open", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service } = yield* f.make;
      expect(yield* code(service.execute("s", { action: "bind", teamId: teamB, projectId }))).toBe(
        "not_found",
      );
      expect(f.values.size).toBe(0);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      // A member of both teams still cannot move an existing link.
      f.roles[teamB]!.alice = "owner";
      expect(yield* code(service.execute("s", { action: "bind", teamId: teamB, projectId }))).toBe(
        "conflict",
      );
      expect(
        yield* code(service.execute("s", { action: "unbind", teamId: teamB, projectId })),
      ).toBe("not_found");
      expect(
        (yield* service.execute("s", { action: "list", teamId: teamB })).projects,
      ).toHaveLength(0);
      expect(
        (yield* service.execute("s", { action: "list", teamId: teamA })).projects,
      ).toHaveLength(1);
      // Unlinking is the explicit way out; afterwards memory access is refused.
      yield* service.execute("s", { action: "unbind", teamId: teamA, projectId });
      expect(yield* code(service.execute("s", { action: "memory-list", projectId }))).toBe(
        "not_found",
      );
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("denies removed, switched, and signed-out accounts before Graph", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      yield* service.execute("s", { action: "memory-list", projectId });
      const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
      const attempts = [
        { action: "memory-status", projectId },
        { action: "memory-list", projectId },
        { action: "memory-read", projectId, path },
        { action: "memory-publish", projectId, recordId, deviceId, title: "T", text: "x" },
        { action: "memory-update", projectId, path, etag: "v1", text: "x" },
        { action: "memory-delete", projectId, path, etag: "v1" },
      ] as const;
      f.graph.length = 0;
      delete f.roles[teamA]!.alice;
      for (const attempt of attempts)
        expect([attempt.action, yield* code(service.execute("s", attempt))]).toEqual([
          attempt.action,
          "not_found",
        ]);
      // Another campus identity in the same environment is a member of team B only.
      f.roles[teamA]!.alice = "editor";
      f.switchTo("mallory");
      for (const attempt of attempts)
        expect([attempt.action, yield* code(service.execute("s", attempt))]).toEqual([
          attempt.action,
          "not_found",
        ]);
      f.signOut();
      for (const attempt of attempts)
        expect(yield* code(service.execute("s", attempt))).toBe("sign_in_required");
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("refuses reader writes and a team whose storage root changed", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      f.roles[teamA]!.alice = "reader";
      const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
      expect(
        yield* code(
          service.execute("s", {
            action: "memory-publish",
            projectId,
            recordId,
            deviceId,
            title: "T",
            text: "x",
          }),
        ),
      ).toBe("forbidden");
      expect(
        yield* code(
          service.execute("s", { action: "memory-update", projectId, path, etag: "v1", text: "x" }),
        ),
      ).toBe("forbidden");
      expect(
        yield* code(service.execute("s", { action: "memory-delete", projectId, path, etag: "v1" })),
      ).toBe("forbidden");
      expect(f.writes).toHaveLength(0);
      // Readers can still read the memory they were given.
      expect(
        (yield* service.execute("s", { action: "memory-list", projectId })).storage?.files,
      ).toHaveLength(1);
      // The team record now points somewhere else: the link is pinned to the root it was made for.
      f.storage[teamA] = { ...f.storage[teamA]!, driveId: "driveB", folderId: "rootB" };
      f.graph.length = 0;
      expect(yield* code(service.execute("s", { action: "memory-list", projectId }))).toBe(
        "conflict",
      );
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("leaves unlinked and deleted projects without team memory", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      expect(
        yield* code(service.execute("s", { action: "memory-list", projectId: otherProject })),
      ).toBe("not_found");
      f.projects.delete(projectId);
      expect(yield* code(service.execute("s", { action: "memory-list", projectId }))).toBe(
        "not_found",
      );
      expect(
        (yield* service.execute("s", { action: "list", teamId: teamA })).projects,
      ).toHaveLength(0);
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("withholds memory a concurrent unlink overtook", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
      for (const attempt of [
        { action: "memory-list", projectId },
        { action: "memory-read", projectId, path },
      ] as const) {
        // The unlink commits while the read is waiting on Graph.
        f.interleave(service.execute("s", { action: "unbind", teamId: teamA, projectId }));
        expect([attempt.action, yield* code(service.execute("s", attempt))]).toEqual([
          attempt.action,
          "not_found",
        ]);
        expect(
          (yield* service.execute("s", { action: "list", teamId: teamA })).projects,
        ).toHaveLength(0);
        yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      }
      // Moved to team B mid-read: team A's listing is not returned under the new link.
      f.roles[teamB]!.alice = "editor";
      f.interleave(
        service
          .execute("s", { action: "unbind", teamId: teamA, projectId })
          .pipe(Effect.andThen(service.execute("s", { action: "bind", teamId: teamB, projectId }))),
      );
      expect(yield* code(service.execute("s", { action: "memory-list", projectId }))).toBe(
        "not_found",
      );
      expect((yield* service.execute("s", { action: "project-link", projectId })).projects).toEqual(
        [expect.objectContaining({ teamId: teamB })],
      );
    }),
  );

  it.effect("reports a project's link only to members of its team", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service } = yield* f.make;
      expect(yield* code(service.execute("s", { action: "project-link", projectId }))).toBe(
        "not_found",
      );
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      expect((yield* service.execute("s", { action: "project-link", projectId })).projects).toEqual(
        [expect.objectContaining({ projectId, teamId: teamA, teamName: "Team A" })],
      );
      f.switchTo("mallory");
      expect(yield* code(service.execute("s", { action: "project-link", projectId }))).toBe(
        "not_found",
      );
    }),
  );

  it.effect("shares chosen thread text to an allowed team with server provenance", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      const share = (teamId: string, thread = threadId) =>
        service.execute("s", {
          action: "share",
          teamId,
          threadId: thread,
          recordId,
          deviceId,
          title: "Finding",
          text: "Use the 2025 template.",
        });
      f.graph.length = 0;
      // Non-member team and unknown thread: nothing reaches Graph.
      expect(yield* code(share(teamB))).toBe("not_found");
      expect(yield* code(share(teamA, ThreadId.make("thread-gone")))).toBe("not_found");
      expect(f.graph).toHaveLength(0);
      f.roles[teamA]!.alice = "reader";
      expect(yield* code(share(teamA))).toBe("forbidden");
      expect(f.writes).toHaveLength(0);
      f.roles[teamA]!.alice = "editor";
      const shared = yield* share(teamA);
      // The saved note is exactly what the preview shows, labelled with the thread's project.
      const expected = formatTeamNote({
        title: "Finding",
        project: "Grant reports",
        text: "Use the 2025 template.",
      });
      expect(shared.storage?.document?.text).toBe(expected);
      expect(f.writes).toEqual([
        expect.objectContaining({
          body: expected,
          url: expect.stringContaining(`/drives/driveA/items/rootA:/Memory/`),
        }),
      ]);
      // A project linked to the team keeps sharing into the root it was linked to.
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      f.storage[teamA] = { ...f.storage[teamA]!, driveId: "driveB", folderId: "rootB" };
      f.graph.length = 0;
      expect(yield* code(share(teamA))).toBe("conflict");
      expect(f.graph).toHaveLength(0);
    }),
  );
});
