// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off - fixtures use host-local times and read the record directly.
/**
 * Daily team memory end to end over the synthetic campus and SharePoint world: the real team pass
 * writes a member's day through the real TeamProject and TeamStorage services, and another member's
 * local copy lists and reads it. The model is a stand-in that echoes what it was given; nothing
 * here proves real Microsoft Graph, SharePoint permission, or model behavior.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { MAX_CATCH_UP_DAYS, PARTIAL_INTERVAL_MS } from "../../memory/DailyMemory.ts";
import { TeamMirrorHost, type TeamMirrorSource } from "../../memory/sync/teamMirror.ts";
import { teamDailyPath } from "../../memory/teamDaily.ts";
import { makeTeamDailyPass } from "../../memory/teamDailyPass.ts";
import { TeamDailyHost } from "../../memory/teamDailySource.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import * as TeamMessageGate from "../TeamMessageGate.ts";
import {
  makeSyntheticTeamServices,
  makeSyntheticTeamsWorld,
  SYNTHETIC_TEAMS,
} from "./syntheticTeams.ts";

const projectId = ProjectId.make("synthetic-project");
const alpha = SYNTHETIC_TEAMS.alpha.id;
const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();

const values = new Map<string, Uint8Array>();
const layer = (baseDir: string) =>
  Layer.mergeAll(
    Layer.mock(ServerSecretStore)({
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
    }),
    Layer.mock(ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                title: "Grant reports",
                workspaceRoot: `/code/${id}`,
                defaultModelSelection: null,
                scripts: [],
                createdAt: at(1, 9),
                updatedAt: at(1, 9),
                deletedAt: null,
              })
            : Option.none(),
        ),
    }),
    Layer.mock(ProjectionStoreV2)({
      getThreadShell: () => Effect.succeed(null),
    }),
    TeamMessageGate.layerMemory(),
    ServerSettings.layerTest({ memoryEnabled: true }),
    Layer.mock(TextGeneration)({
      generateTeamDailyMemory: (input) =>
        Effect.succeed({
          threads: input.threads.map((thread) => ({
            key: thread.key,
            summary: thread.activity.replace(/\s+/gu, " "),
            items: [{ kind: "outcome" as const, text: "Finished." }],
          })),
        }),
    }),
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
  );

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const created = at(1, 9);
  for (const [id, title] of [
    [projectId, "Grant reports"],
    ["personal", "Personal"],
  ] as const)
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${id}, ${title}, ${`/code/${id}`}, '[]', ${created}, ${created})
    `;
  for (const [thread, project, title] of [
    ["kept", projectId, "Budget checklist"],
    ["withdrawn", projectId, "Draft reply"],
    ["private", "personal", "Personal errand"],
  ] as const)
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${thread}, ${project}, ${title}, 'codex', 'approval-required', 'default', ${created}, ${created}, '{}')
    `;
});
const say = (id: string, thread: string, text: string, createdAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${thread}, ${`turn-${id}`}, 'user', 0, ${createdAt}, ${createdAt}, json_object('text', ${text}))
    `;
  });

describe("Daily team memory over the synthetic world", () => {
  it.layer(NodeServices.layer)("end to end", (it) => {
    it.effect("shares a member's linked work, and a teammate's copy follows a withdrawal", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-e2e-" });
        yield* Effect.gen(function* () {
          values.clear();
          yield* TestClock.setTime(new Date(2026, 9, 10, 9).getTime());
          const world = makeSyntheticTeamsWorld();
          world.switchTo("member");
          const pass = yield* makeTeamDailyPass({
            stateDir: baseDir,
            deviceLabel: "Synthetic Mac",
            settings: yield* ServerSettings.ServerSettingsService,
            textGeneration: yield* TextGeneration,
            maxCatchUpDays: MAX_CATCH_UP_DAYS,
            partialIntervalMs: PARTIAL_INTERVAL_MS,
            streamingGraceMs: 2 * 60 * 60_000,
          });
          let mirror: TeamMirrorSource | null = null;
          const services = yield* makeSyntheticTeamServices(world).pipe(
            Effect.provideService(TeamDailyHost, TeamDailyHost.of(pass)),
            Effect.provideService(
              TeamMirrorHost,
              TeamMirrorHost.of({
                attach: (source) => Effect.sync(() => void (mirror = source)),
                sync: Effect.void,
                prune: Effect.void,
              }),
            ),
          );
          yield* services.project.teams("s", { action: "list" });
          yield* services.project.execute("s", { action: "bind", teamId: alpha, projectId });
          expect(yield* services.connectMicrosoft).toBe(1);

          // Work after the link, in the linked project and in a personal one.
          yield* seed;
          yield* TestClock.setTime(new Date(2026, 9, 10, 15).getTime());
          yield* say("m1", "kept", "Checked the budget lines", at(10, 11));
          yield* say("m2", "withdrawn", "Drafted the sponsor reply", at(10, 12));
          yield* say("m3", "private", "Booked a dentist", at(10, 12));
          yield* pass.run;
          expect(yield* pass.status(alpha)).toMatchObject({ state: "sharing" });

          // The owner's Harness copies the team, including the member's day.
          world.switchTo("owner");
          yield* services.project.teams("s", { action: "list" });
          yield* services.connectMicrosoft;
          // Every team the owner belongs to is copied, without a project link of their own.
          const copies = yield* mirror!.teams;
          expect(copies.map((copy) => copy.teamId)).toContain(alpha);
          const listing = yield* mirror!.list(alpha);
          const daily =
            listing.kind === "files"
              ? listing.files.filter((f) => f.path.startsWith("Daily/"))
              : [];
          expect(daily).toHaveLength(1);
          const first = yield* mirror!.read(alpha, daily[0]!.path);
          expect(first.kind === "file" && first.text).toContain("Checked the budget lines");
          expect(first.kind === "file" && first.text).toContain("Drafted the sponsor reply");
          expect(first.kind === "file" && first.text).not.toContain("dentist");
          yield* mirror!.report(alpha, {
            kind: "synced",
            at: at(10, 15),
            files: 1,
            skipped: 0,
            pending: 0,
          });

          // Back on the member's Harness: one thread is withdrawn.
          world.switchTo("member");
          yield* services.project.teams("s", { action: "list" });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.teamSharingOffAt', ${at(10, 16)}) WHERE thread_id = 'withdrawn'`;
          yield* pass.run;

          world.switchTo("owner");
          yield* services.project.teams("s", { action: "list" });
          const again = yield* mirror!.list(alpha);
          const updated =
            again.kind === "files" ? again.files.find((f) => f.path === daily[0]!.path) : undefined;
          expect(updated?.eTag).not.toBe(daily[0]!.eTag);
          const second = yield* mirror!.read(alpha, daily[0]!.path);
          expect(second.kind === "file" && second.text).toContain("Checked the budget lines");
          expect(second.kind === "file" && second.text).not.toContain("Drafted the sponsor reply");

          // Unlinking the project shares nothing new; the published day stays with the team.
          world.switchTo("member");
          yield* services.project.teams("s", { action: "list" });
          yield* services.project.execute("s", { action: "unbind", teamId: alpha, projectId });
          yield* say("m4", "kept", "After unlinking", at(10, 17));
          yield* TestClock.adjust(PARTIAL_INTERVAL_MS + 60_000);
          yield* pass.run;
          world.switchTo("owner");
          yield* services.project.teams("s", { action: "list" });
          const third = yield* mirror!.read(alpha, daily[0]!.path);
          expect(third.kind === "file" && third.text).toContain("Checked the budget lines");
          expect(third.kind === "file" && third.text).not.toContain("After unlinking");
        }).pipe(Effect.provide(layer(baseDir)));
      }),
    );

    it.effect("leaves a day file a teammate edited in SharePoint alone, and says so", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-e2e-" });
        yield* Effect.gen(function* () {
          values.clear();
          yield* TestClock.setTime(new Date(2026, 9, 10, 9).getTime());
          const world = makeSyntheticTeamsWorld();
          world.switchTo("member");
          const pass = yield* makeTeamDailyPass({
            stateDir: baseDir,
            deviceLabel: "Synthetic Mac",
            settings: yield* ServerSettings.ServerSettingsService,
            textGeneration: yield* TextGeneration,
            maxCatchUpDays: MAX_CATCH_UP_DAYS,
            partialIntervalMs: PARTIAL_INTERVAL_MS,
            streamingGraceMs: 2 * 60 * 60_000,
          });
          const services = yield* makeSyntheticTeamServices(world).pipe(
            Effect.provideService(TeamDailyHost, TeamDailyHost.of(pass)),
          );
          yield* services.project.teams("s", { action: "list" });
          yield* services.project.execute("s", { action: "bind", teamId: alpha, projectId });
          yield* services.connectMicrosoft;
          yield* seed;
          yield* TestClock.setTime(new Date(2026, 9, 10, 15).getTime());
          yield* say("m1", "kept", "Checked the budget lines", at(10, 11));
          yield* say("m2", "withdrawn", "Drafted the sponsor reply", at(10, 12));
          yield* pass.run;
          const state = JSON.parse(
            yield* fs.readFileString(`${baseDir}/team-daily/state.json`),
          ) as { author: string; deviceId: string };
          const path = teamDailyPath(state.author, "2026-10-10", state.deviceId);
          expect(world.readDocument("alpha", path)).toContain("Drafted the sponsor reply");

          // The owner edits the member's file directly in SharePoint.
          const edited = `${world.readDocument("alpha", path)!}\nOwner's note.`;
          world.editDocument("alpha", path, edited, "owner");
          // The member withdraws a thread; Harness won't overwrite the edited file.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.teamSharingOffAt', ${at(10, 16)}) WHERE thread_id = 'withdrawn'`;
          yield* pass.run;
          expect(world.readDocument("alpha", path)).toBe(edited);
          expect((yield* pass.status(alpha))?.message).toContain("changed in SharePoint");
          // It stays that way on later passes, and still says why.
          yield* pass.run;
          expect(world.readDocument("alpha", path)).toBe(edited);
          expect((yield* pass.status(alpha))?.message).toContain("chose not to share");
        }).pipe(Effect.provide(layer(baseDir)));
      }),
    );
  });
});
