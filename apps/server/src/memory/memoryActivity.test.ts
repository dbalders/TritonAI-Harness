// @effect-diagnostics nodeBuiltinImport:off - Test approvals use synchronous SHA-256 document fingerprints.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { seedV2Activity } from "../persistence/HarnessActivity.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  TextGeneration,
  type DailyMemoryGenerationInput,
  type TeamDailyMemoryGenerationInput,
} from "../textGeneration/TextGeneration.ts";
import * as TeamMessageGate from "../teams/TeamMessageGate.ts";
import {
  deviceId,
  identityOf,
  projectId,
  recordId,
  teamA,
  teamProjectFixture,
  threadId,
} from "../teams/testing/teamProjectFixture.ts";
import * as DailyMemory from "./DailyMemory.ts";

const start = "2026-10-20T18:00:00.000Z";
const at = "2026-10-20T20:00:00.000Z";
const now = "2026-10-21T20:00:00.000Z";
const protectedText = "UNSENT_TEAM_SKILL_MUST_NOT_REACH_AUXILIARY_MODELS";

it.layer(NodeServices.layer)("memory activity", (it) => {
  it.effect(
    "excludes revoked queued, failed, and unsent steering context from both memory providers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "team-memory-authorization-" });
        const personalInputs: DailyMemoryGenerationInput[] = [];
        const teamInputs: TeamDailyMemoryGenerationInput[] = [];
        const layer = Layer.mergeAll(
          ServerSettings.layerTest({
            memoryEnabled: true,
            providerInstances: {
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                config: { homePath: path.join(dir, "codex") },
              },
            },
          }),
          Layer.mock(ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: "3f2a9c1e-0000-4000-8000-000000000001",
              label: "Test Mac",
              platform: { os: "darwin", arch: "arm64" },
            } as ExecutionEnvironmentDescriptor),
          }),
          Layer.mock(TextGeneration)({
            generateDailyMemory: (input) =>
              Effect.sync(() => {
                personalInputs.push(input);
                return {
                  overview: "Accepted work.",
                  projects: input.projectNames.map((project) => ({
                    project,
                    workedOn: ["Accepted work."],
                    recent: "Accepted work.",
                  })),
                  decisions: [],
                  openLoops: [],
                };
              }),
            generateTeamDailyMemory: (input) =>
              Effect.sync(() => {
                teamInputs.push(input);
                return {
                  threads: input.threads.map(({ key }) => ({
                    key,
                    summary: "Accepted work.",
                    items: [],
                  })),
                };
              }),
          }),
          TeamMessageGate.layer,
        ).pipe(
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
        );
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(start));
          const sql = yield* SqlClient.SqlClient;
          const gate = yield* TeamMessageGate.TeamMessageGate;
          const f = teamProjectFixture();
          const made = yield* f.makeWithGate(gate);
          yield* made.connect(teamA);
          yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
          const skillPath = `Skills/${identityOf("alice")}/${deviceId}/${recordId}.md`;
          f.contents.set(`rootA:${skillPath}`, "Previously accepted team context.");
          const reference = (yield* made.service.execute("s", {
            action: "skill-attach",
            projectId,
            path: skillPath,
          })).reference!;
          const prepare = (id: string, text: string, references: readonly string[] = []) =>
            made.service.prepareOutgoingCommand("s", {
              type: "message.dispatch",
              commandId: CommandId.make(`prepare-${id}`),
              messageId: MessageId.make(id),
              threadId,
              text,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "queue_after_active" },
              teamReferences: references,
            });
          const accepted = yield* prepare("accepted", `ACCEPTED_TEAM_HISTORY\n${reference.block}`, [
            reference.id,
          ]);
          const ordinary = yield* prepare("ordinary", "ORDINARY_QUEUED_TEXT");
          f.contents.set(`rootA:${skillPath}`, protectedText);
          yield* made.service.execute("s", {
            action: "skill-enable",
            projectId,
            path: skillPath,
            version: NodeCrypto.createHash("sha256").update(protectedText).digest("hex"),
          });
          const queued = yield* prepare("queued", "Queued work.");
          const failed = yield* prepare("failed", "Refused work.");
          const steer = yield* prepare("steer", "Unsent steering.");
          const prepared = [accepted, ordinary, queued, failed, steer].map((command) => {
            if (command.type !== "message.dispatch") throw new Error("Expected a message");
            return command;
          });
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${projectId}, 'Grant reports', '/work/project-a', '[]', ${start}, ${at})`;
          yield* seedV2Activity({
            threadId,
            projectId,
            title: "Auxiliary authorization",
            at,
            messages: prepared.map((command) => ({
              id: command.messageId,
              role: "user",
              text: command.text,
            })),
          });
          for (const command of prepared) {
            const runId =
              command.messageId === "steer" ? "run-accepted" : `run-${command.messageId}`;
            yield* sql`UPDATE orchestration_v2_projection_messages SET run_id = ${runId} WHERE message_id = ${command.messageId}`;
            if (command.messageId === "steer") continue;
            yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${runId}, ${threadId}, ${prepared.indexOf(command) + 1}, 'codex', ${command.messageId === "accepted" ? "completed" : command.messageId === "failed" ? "failed" : "queued"}, ${at}, json_object('userMessageId', ${command.messageId}))`;
          }
          yield* sql`INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
        VALUES ('accepted-attempt', ${threadId}, 'run-accepted', 1, 'accepted-node', 'codex', 'provider-thread', 'completed', '{}')`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, payload_json)
        VALUES ('accepted-turn', ${threadId}, 'provider-thread', 'accepted-node', 'accepted-attempt', 1, 'completed', ${at}, '{}')`;
          yield* made.service.execute("s", { action: "skill-disable", projectId, path: skillPath });
          assert.equal(
            (yield* Effect.result(
              gate.verifyBeforeSend({
                messageId: "queued",
                threadId,
                text: prepared.find((command) => command.messageId === "queued")!.text,
              }),
            ))._tag,
            "Failure",
          );
          const memory = yield* DailyMemory.make;
          yield* memory.teams.attach({
            account: () =>
              Effect.succeed({
                kind: "signed-in",
                author: identityOf("alice"),
                authorName: "Alice",
                workspaces: [
                  {
                    teamId: teamA,
                    teamName: "Team A",
                    access: "ready",
                    storageKey: "rootA",
                    projects: [{ projectId, sharingSince: start }],
                  },
                ],
              }),
            inspect: () => Effect.succeed({ kind: "missing" }),
            write: () => Effect.succeed({ kind: "written", etag: "etag", storageKey: "rootA" }),
          });
          yield* TestClock.setTime(Date.parse(now));
          yield* memory.runCatchUp;
          assert.isAbove(personalInputs.length, 0);
          assert.isAbove(teamInputs.length, 0);
          for (const payload of [
            ...personalInputs.map((input) => input.activity),
            ...teamInputs.flatMap((input) => input.threads.map((thread) => thread.activity)),
          ]) {
            assert.notInclude(payload, protectedText);
            assert.include(payload, "ACCEPTED_TEAM_HISTORY");
            assert.include(payload, "ORDINARY_QUEUED_TEXT");
          }
        }).pipe(Effect.provide(layer));
      }),
  );
});
