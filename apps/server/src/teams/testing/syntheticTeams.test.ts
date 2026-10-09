import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  formatTeamContext,
  MessageId,
  ProjectId,
  type OrchestrationThreadShell,
  ThreadId,
  TeamsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  SYNTHETIC_OAUTH,
  SYNTHETIC_TEAMS,
  makeSyntheticTeamServices,
  makeSyntheticTeamsWorld,
  syntheticDocumentPath,
} from "./syntheticTeams.ts";

const projectId = ProjectId.make("synthetic-project");
const threadId = ThreadId.make("synthetic-thread");
const alpha = SYNTHETIC_TEAMS.alpha.id;
const beta = SYNTHETIC_TEAMS.beta.id;
const ownerNote = syntheticDocumentPath(0);
const ownerSkill = syntheticDocumentPath(2);
const hiddenSkill = syntheticDocumentPath(3);
const betaNote = syntheticDocumentPath(4);

const values = new Map<string, Uint8Array>();
const environment = Layer.mergeAll(
  Layer.mock(ServerSecretStore)({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  }),
  Layer.mock(ProjectionSnapshotQuery)({
    getProjectShellById: (id) =>
      Effect.succeed(
        id === projectId
          ? Option.some({
              id,
              title: "synthetic-grant-reports",
              workspaceRoot: "/synthetic/workspace",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-09T00:00:00.000Z",
              updatedAt: "2026-10-09T00:00:00.000Z",
            })
          : Option.none(),
      ),
    getThreadShellById: (id) =>
      Effect.succeed(
        id === threadId
          ? Option.some({ id, projectId } as unknown as OrchestrationThreadShell)
          : Option.none(),
      ),
  }),
);
const code = <A>(effect: Effect.Effect<A, TeamsError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code));
const turn = (text: string) =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-synthetic"),
    threadId,
    message: { messageId: MessageId.make("msg-synthetic"), role: "user", text, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-09T00:00:00.000Z",
  }) as const;

/** A fresh world and services with session "s" linked to Alpha and connected to Microsoft. */
const linkedAlpha = (as: "owner" | "editor" | "reader" = "editor") =>
  Effect.gen(function* () {
    values.clear();
    const world = makeSyntheticTeamsWorld();
    world.switchTo(as);
    const services = yield* makeSyntheticTeamServices(world);
    yield* services.project.execute("s", { action: "bind", teamId: alpha, projectId });
    expect(yield* services.connectMicrosoft).toBe(1);
    return { world, ...services };
  }).pipe(Effect.provide(environment));

describe("Synthetic Teams world", () => {
  it.effect("adds the linked team's memory and skill through the real services", () =>
    Effect.gen(function* () {
      const { world, project } = yield* linkedAlpha();
      world.trace.length = 0;
      const listed = yield* project.execute("s", { action: "memory-list", projectId });
      expect(listed.storage?.files.map((file) => file.path).toSorted()).toEqual(
        [ownerNote, syntheticDocumentPath(1)].toSorted(),
      );
      expect(Object.values(listed.authors ?? {})).toContain("Synthetic Owner");
      const memory = yield* project.execute("s", {
        action: "memory-attach",
        projectId,
        path: ownerNote,
      });
      expect(memory.reference?.block).toContain("SYNTHETIC grant report checklist");
      const skill = yield* project.execute("s", {
        action: "skill-attach",
        projectId,
        path: ownerSkill,
      });
      expect(skill.reference?.block).toContain("<team-skill");
      yield* project.execute("s", {
        action: "memory-verify",
        references: [memory.reference!.id, skill.reference!.id],
      });
      expect(
        yield* code(project.execute("s", { action: "skill-attach", projectId, path: hiddenSkill })),
      ).toBe("invalid_request");
      // Every request stayed in Alpha's drive, and no Graph bearer reached the download host.
      expect(world.trace.length).toBeGreaterThan(0);
      for (const entry of world.trace) {
        expect(entry.kind === "graph" || entry.kind === "download").toBe(true);
        if (entry.kind === "graph" && entry.path !== "/v1.0/me") {
          expect(entry.team).toBe("alpha");
          expect(entry.path).toContain(
            `/drives/${encodeURIComponent(SYNTHETIC_TEAMS.alpha.driveId)}/`,
          );
        }
        if (entry.kind === "download") expect(entry.note).toBe("served");
      }
    }),
  );

  it.effect("refuses another team's root and a member removed before sending", () =>
    Effect.gen(function* () {
      const { world, project, storage } = yield* linkedAlpha();
      // The editor is not in Beta: no link, and no read with Alpha's root either.
      expect(yield* code(project.execute("s", { action: "bind", teamId: beta, projectId }))).toBe(
        "not_found",
      );
      expect(
        yield* code(storage.execute("s", { action: "read-file", teamId: beta, path: betaNote })),
      ).toBe("not_found");
      const memory = yield* project.execute("s", {
        action: "memory-attach",
        projectId,
        path: ownerNote,
      });
      world.setRole("alpha", "editor", "none");
      expect(
        yield* code(
          project.execute("s", { action: "memory-verify", references: [memory.reference!.id] }),
        ),
      ).toBe("not_found");
      expect(
        yield* code(
          project.authorizeOutgoingCommand("s", turn(`Draft\n${memory.reference!.block}`)),
        ),
      ).toBe("not_found");
    }),
  );

  it.effect("answers a cross-team Graph request as SharePoint would, without a network", () =>
    Effect.gen(function* () {
      const world = makeSyntheticTeamsWorld();
      const form = (endpoint: string, params: Record<string, string>) =>
        world.http
          .execute(
            HttpClientRequest.post(
              `https://login.microsoftonline.com/${SYNTHETIC_OAUTH.tenantId}/oauth2/v2.0/${endpoint}`,
            ).pipe(
              HttpClientRequest.bodyUrlParams({ client_id: SYNTHETIC_OAUTH.clientId, ...params }),
            ),
          )
          .pipe(Effect.flatMap((response) => response.json));
      // An unarmed device flow never yields a Microsoft URL for a browser to open.
      const refused = yield* form("devicecode", { scope: "Sites.Selected" });
      expect(refused).toMatchObject({ error: "invalid_request" });
      world.switchTo("editor");
      const { access_token } = (yield* world.withDeviceFlow(
        Effect.gen(function* () {
          const { device_code } = (yield* form("devicecode", {})) as { device_code: string };
          return yield* form("token", {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code,
          });
        }),
      )) as { access_token: string };
      const get = (url: string) =>
        world.http
          .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(access_token)))
          .pipe(Effect.map((response) => response.status));
      const drive = (team: "alpha" | "beta") =>
        `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(SYNTHETIC_TEAMS[team].driveId)}/items/`;
      expect(yield* get(`${drive("alpha")}01SYNTHTEAM-alpha:/Memory`)).toBe(200);
      // Beta's root under Alpha's drive, and Beta's drive for a non-member.
      expect(yield* get(`${drive("alpha")}01SYNTHTEAM-beta:/Memory`)).toBe(404);
      expect(yield* get(`${drive("beta")}01SYNTHTEAM-beta:/Memory`)).toBe(403);
      expect(yield* get("https://example.com/")).toBe(502);
      expect(world.trace.at(-1)).toMatchObject({ kind: "blocked", host: "example.com" });
      // Codes and tokens are never traced.
      for (const entry of world.trace)
        expect(Object.values(entry).some((value) => String(value).includes(access_token))).toBe(
          false,
        );
    }),
  );

  it.effect("keeps a reviewed version from overwriting a newer edit", () =>
    Effect.gen(function* () {
      const { world, project } = yield* linkedAlpha("owner");
      const read = yield* project.execute("s", {
        action: "memory-read",
        projectId,
        path: ownerNote,
      });
      const reviewed = read.storage!.document!;
      world.editDocument(
        "alpha",
        ownerNote,
        "# SYNTHETIC grant report checklist\n\nEdited elsewhere.",
      );
      expect(
        yield* code(
          project.execute("s", {
            action: "memory-update",
            projectId,
            path: ownerNote,
            etag: reviewed.etag,
            text: `${reviewed.text}\n\nMy change.`,
          }),
        ),
      ).toBe("conflict");
      const edited = yield* project.execute("s", {
        action: "memory-read",
        projectId,
        path: ownerNote,
      });
      expect(edited.storage?.document?.text).toContain("Edited elsewhere.");
      world.restoreDocument("alpha", ownerNote);
      const restored = yield* project.execute("s", {
        action: "memory-read",
        projectId,
        path: ownerNote,
      });
      expect(restored.storage?.document?.text).toBe(reviewed.text);
      expect(restored.storage?.document?.etag).not.toBe(reviewed.etag);
    }),
  );

  it.effect("refuses a download host outside the team's site before downloading", () =>
    Effect.gen(function* () {
      const { world, project } = yield* linkedAlpha();
      world.setDownloadHost("alpha", "synthetic-elsewhere.sharepoint.com");
      world.trace.length = 0;
      const error = yield* Effect.flip(
        project.execute("s", { action: "memory-attach", projectId, path: ownerNote }),
      );
      expect(error.message).toContain("unexpected download host");
      expect(world.trace.some((entry) => entry.kind === "download")).toBe(false);
    }),
  );

  it.effect("rejects a link whose team folder moved", () =>
    Effect.gen(function* () {
      const { world, project } = yield* linkedAlpha();
      world.moveRoot("alpha");
      expect(yield* code(project.execute("s", { action: "memory-list", projectId }))).toBe(
        "conflict",
      );
      world.restoreRoot("alpha");
      const listed = yield* project.execute("s", { action: "memory-list", projectId });
      expect(listed.storage?.files.length).toBe(2);
    }),
  );
});

describe("Team document list summaries", () => {
  const summaries = (files: ReadonlyArray<{ path: string; summary?: unknown }> | undefined) =>
    Object.fromEntries((files ?? []).map((file) => [file.path, file.summary ?? null]));

  it.effect("titles the linked team's notes and skills from their headers", () =>
    Effect.gen(function* () {
      const { world, project } = yield* linkedAlpha();
      world.trace.length = 0;
      const memory = yield* project.execute("s", { action: "memory-list", projectId });
      expect(summaries(memory.storage?.files)).toEqual({
        [ownerNote]: { title: "SYNTHETIC grant report checklist", description: "", hidden: false },
        [syntheticDocumentPath(1)]: {
          title: "SYNTHETIC reviewer contacts",
          description: "",
          hidden: false,
        },
      });
      const skills = yield* project.execute("s", { action: "skill-list", projectId });
      expect(summaries(skills.storage?.files)).toEqual({
        [ownerSkill]: {
          title: "SYNTHETIC report formatter",
          description: "Formats a synthetic grant report summary as a short table.",
          hidden: false,
        },
        // Listed and titled, but flagged: using it is still refused.
        [hiddenSkill]: {
          title: "SYNTHETIC hidden-character skill",
          description: "Contains a zero-width character; Harness should refuse to use it.",
          hidden: true,
        },
      });
      expect(
        yield* code(project.execute("s", { action: "skill-read", projectId, path: hiddenSkill })),
      ).toBe("invalid_request");
      // Only Alpha's drive and download host were touched, with no bearer on a download.
      for (const entry of world.trace) {
        if (entry.kind === "graph" && entry.path !== "/v1.0/me") expect(entry.team).toBe("alpha");
        if (entry.kind === "download") expect(entry.note).toBe("served");
      }
    }),
  );

  it.effect("summarizes at most twenty documents per list", () =>
    Effect.gen(function* () {
      const { world, project } = yield* linkedAlpha();
      for (let index = 0; index < 22; index++)
        yield* project.execute("s", {
          action: "memory-publish",
          projectId,
          recordId: `cccccccc-0000-4000-a000-${String(index).padStart(12, "0")}`,
          deviceId: "dddddddd-0000-4000-a000-000000000001",
          title: `Bulk note ${index}`,
          text: "Synthetic bulk note.",
        });
      world.trace.length = 0;
      const listed = yield* project.execute("s", { action: "memory-list", projectId });
      const files = listed.storage?.files ?? [];
      expect(files).toHaveLength(24);
      expect(files.filter((file) => file.summary)).toHaveLength(20);
      expect(world.trace.filter((entry) => entry.kind === "download")).toHaveLength(20);
    }),
  );

  it.effect("leaves a document untitled when its summary can't be read safely", () =>
    Effect.gen(function* () {
      const { world, project } = yield* linkedAlpha();
      world.setDownloadHost("alpha", "synthetic-elsewhere.sharepoint.com");
      world.trace.length = 0;
      const listed = yield* project.execute("s", { action: "memory-list", projectId });
      expect(listed.storage?.files).toHaveLength(2);
      expect(listed.storage?.files.every((file) => file.summary === undefined)).toBe(true);
      expect(world.trace.some((entry) => entry.kind === "download")).toBe(false);
    }),
  );

  it.effect("withholds the whole list when access is revoked while summarizing", () =>
    Effect.gen(function* () {
      values.clear();
      const world = makeSyntheticTeamsWorld();
      world.switchTo("editor");
      let revokeOnDownload = false;
      const http = HttpClient.make((request) =>
        Effect.suspend(() => {
          if (revokeOnDownload && new URL(request.url).hostname.endsWith(".sharepoint.com")) {
            revokeOnDownload = false;
            world.setRole("alpha", "editor", "none");
          }
          return world.http.execute(request);
        }),
      );
      const { project, connectMicrosoft } = yield* makeSyntheticTeamServices({ ...world, http });
      yield* project.execute("s", { action: "bind", teamId: alpha, projectId });
      yield* connectMicrosoft;
      revokeOnDownload = true;
      expect(yield* code(project.execute("s", { action: "memory-list", projectId }))).toBe(
        "not_found",
      );
      expect(revokeOnDownload).toBe(false);
      world.setRole("alpha", "editor", "editor");
      expect(
        (yield* project.execute("s", { action: "memory-list", projectId })).storage?.files,
      ).toHaveLength(2);
    }).pipe(Effect.provide(environment)),
  );

  it.effect("returns the current document with an attach so a changed title is reviewed", () =>
    Effect.gen(function* () {
      const { world, project } = yield* linkedAlpha();
      const previewed = yield* project.execute("s", {
        action: "memory-read",
        projectId,
        path: ownerNote,
      });
      world.editDocument("alpha", ownerNote, "# SYNTHETIC renamed checklist\n\nEdited text.");
      const attached = yield* project.execute("s", {
        action: "memory-attach",
        projectId,
        path: ownerNote,
      });
      const current = attached.storage?.document;
      expect(current?.text).toBe("# SYNTHETIC renamed checklist\n\nEdited text.");
      expect(current?.etag).not.toBe(previewed.storage?.document?.etag);
      // The issued block is exactly the returned document, so its title labels what is added.
      expect(attached.reference?.block).toBe(
        formatTeamContext({
          kind: "memory",
          teamName: attached.reference!.teamName,
          path: ownerNote,
          text: current!.text,
        }),
      );
      const listed = yield* project.execute("s", { action: "memory-list", projectId });
      expect(summaries(listed.storage?.files)[ownerNote]).toEqual({
        title: "SYNTHETIC renamed checklist",
        description: "",
        hidden: false,
      });
    }),
  );
});
