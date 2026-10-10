import {
  type AccountStatus,
  ProjectId,
  ThreadId,
  type OrchestrationThreadShell,
  type TeamRole,
  type TeamStorage as TeamStorageRecord,
  TeamsError,
  type TeamsResult,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { AccountService } from "../../auth/AccountService.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TeamProject from "../TeamProjectService.ts";
import * as TeamStorage from "../TeamStorageService.ts";

export const teamA = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
export const teamB = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
export const tenantId = "22222222-2222-4222-a222-222222222222";
const config = { clientId: "11111111-1111-4111-a111-111111111111", tenantId };
export const projectId = ProjectId.make("project-a");
export const otherProject = ProjectId.make("project-personal");
export const recordId = "33333333-3333-4333-a333-333333333333";
export const deviceId = "44444444-4444-4444-a444-444444444444";
export const threadId = ThreadId.make("thread-a");
const issuer = "https://campus.example.test";
/** The author folder a campus subject's documents are saved under, as the membership service names it. */
export const identityOf = (subject: string) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([issuer, subject]))
    .digest("base64url");

/**
 * Team project services over a synthetic campus account, Graph, and project read model. Tests
 * change membership, roles, and storage roots through the returned handles.
 */
export function teamProjectFixture() {
  let subject = "alice";
  let signedIn = true;
  // The membership service is unreachable while set.
  let teamsDown = false;
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
  // Document text by "<root>:<path>"; others read as "Shared note from <root>:<path>".
  const contents = new Map<string, string>();
  // Documents by "<root>:<path>" that Graph answers as not found.
  const removed = new Set<string>();
  const graph: string[] = [];
  // Runs once, inside the next Graph request, to interleave another call with an in-flight one.
  let duringGraph: Effect.Effect<unknown, TeamsError> | null = null;
  // Runs once, after the next membership read is answered, to land a change behind that read.
  let afterTeams: (() => void) | null = null;
  const writes: { method: string; url: string; body: string }[] = [];
  const status = (): AccountStatus => ({
    configured: true,
    status: signedIn ? "signed-in" : "signed-out",
    serviceUrl: "https://accounts.example.test",
    profile: signedIn
      ? {
          issuer,
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
      Effect.suspend((): Effect.Effect<TeamsResult, TeamsError> => {
        if (teamsDown)
          return Effect.fail(new TeamsError({ code: "unavailable", message: "Teams is down." }));
        if (command.action === "list")
          return Effect.succeed({
            teams: (signedIn ? [teamA, teamB] : [])
              .filter((teamId) => roles[teamId]?.[subject])
              .map((teamId) => ({
                id: teamId,
                reference: "T-12345678",
                name: teamId === teamA ? "Team A" : "Team B",
                role: roles[teamId]![subject]!,
                canManage: roles[teamId]![subject] === "owner",
                state: "ready" as const,
                revision: 1,
              })),
            invitations: [],
            team: null,
            invitationCode: null,
          });
        const teamId = "teamId" in command ? command.teamId : "";
        const role = signedIn ? roles[teamId]?.[subject] : undefined;
        if (!role)
          return Effect.fail(new TeamsError({ code: "not_found", message: "Team unavailable" }));
        const landed = afterTeams;
        afterTeams = null;
        landed?.();
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
            members: Object.entries(roles[teamId] ?? {}).map(([member, memberRole]) => ({
              identityId: identityOf(member),
              displayName: `${member[0]!.toUpperCase()}${member.slice(1)}`,
              email: `${member}@ucsd.edu`,
              role: memberRole,
            })),
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
          new Response(
            contents.get(url.pathname.slice(1)) ?? `Shared note from ${url.pathname.slice(1)}`,
          ),
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
      if (removed.has(`${root}:${path}`)) return json(null, 404);
      if (suffix?.endsWith("children"))
        return json({
          value:
            path === "Memory"
              ? [item([...parts, "note.md"], true)]
              : path === "Skills"
                ? [item([...parts, "skill.md"], true)]
                : [],
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
    return { service, connect, account, storage: storageService };
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
    contents,
    removed,
    interleave: (effect: Effect.Effect<unknown, TeamsError>) => {
      duringGraph = effect;
    },
    afterMembershipRead: (change: () => void) => {
      afterTeams = change;
    },
    switchTo: (next: string) => {
      subject = next;
    },
    signOut: () => {
      signedIn = false;
    },
    signIn: () => {
      signedIn = true;
    },
    setTeamsDown: (down: boolean) => {
      teamsDown = down;
    },
  };
}
