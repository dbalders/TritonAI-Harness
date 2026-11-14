// @effect-diagnostics globalDate:off - fixtures are built from host-local times.
import { describe } from "vite-plus/test";
import { seedV2Activity } from "../persistence/HarnessActivity.testkit.ts";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ProjectId,
  type ExecutionEnvironmentDescriptor,
  TextGenerationError,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type DailyMemoryGenerationInput,
  type DailyMemoryGenerationResult,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import * as DailyMemory from "./DailyMemory.ts";
import { memorySkillName } from "./memoryVault.ts";

const localIso = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
const NOW = new Date(2026, 8, 29, 9).getTime();
const NOON_28 = new Date(2026, 8, 28, 12);
const AFTER_MIDNIGHT_30 = new Date(2026, 8, 30, 1).getTime();
const readCoverage = (text: string) =>
  JSON.parse(text) as {
    readonly coveredFrom: string | null;
    readonly lastSummarizedDay: string;
    readonly notes: Record<string, { readonly path: string; readonly sha256: string }>;
  };
const DEVICE_ID = "3f2a9c1e-0000-4000-8000-000000000001";
const DEVICE = "Test Mac (3f2a)";

/** Where this test device writes, relative to the general vault. */
const files = (path: Path.Path, vault: string) => ({
  daily: (day: string) => path.join(vault, "Daily", day.slice(0, 4), `${day} ${DEVICE}.md`),
  project: (name: string) => path.join(vault, "Projects", name, `${name} - ${DEVICE}.md`),
  inbox: path.join(vault, "Inbox", "3f2a"),
  processed: (day: string) => path.join(vault, "Inbox", "3f2a", "processed", day),
  coverage: path.join(vault, ".devices", DEVICE_ID, "coverage.json"),
  recovered: (relativePath: string) => path.join(vault, "Notes", "Recovered", relativePath),
});

const summaryFor = (input: DailyMemoryGenerationInput): DailyMemoryGenerationResult => ({
  overview: `Work on ${input.day}.`,
  projects: input.projectNames.map((project) => ({
    project,
    workedOn: [`Progress on ${input.day}.`],
    recent: `Progress ${input.day}`,
  })),
  decisions: [],
  openLoops: ["Confirm the fix in staging."],
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const created = localIso(20, 9);
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project-1', 'Acme App', '/code/acme', '[]', ${created}, ${created})
  `;
  for (const [threadId, title, deletedAt] of [
    ["thread-1", "Fix the login redirect", null],
    ["thread-2", "Deleted experiment", created],
  ] as const) {
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, branch, created_at, updated_at, deleted_at)
      VALUES (${threadId}, 'project-1', ${title}, 'fix/login', ${created}, ${created}, ${deletedAt})
    `;
  }
  yield* sql`
    INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at, resume_cursor_json)
    VALUES ('thread-1', 'codex', 'codex', 'ready', ${created}, '{"threadId":"codex-thread-a"}')
  `;
  const messages = [
    ["m1", "thread-1", "user", "Why does login loop?", localIso(26, 10)],
    ["m2", "thread-1", "assistant", "The redirect drops the cookie.", localIso(26, 11)],
    ["m3", "thread-1", "user", "Fix it and open a PR.", localIso(28, 10)],
    ["m4", "thread-1", "assistant", "Fixed and opened PR 12.", localIso(28, 11)],
    ["m5", "thread-2", "user", "Deleted work", localIso(27, 10)],
    ["m6", "thread-1", "user", "Still today", localIso(29, 8)],
  ] as const;
  for (const [messageId, threadId, role, text, at] of messages) {
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${messageId}, ${threadId}, ${`turn-${messageId}`}, ${role}, ${text}, 0, ${at}, ${at})
    `;
  }
});

const makeHarness = (options: {
  readonly memoryEnabled?: boolean;
  readonly profile?: "stable" | "nightly";
  readonly generate?: (
    input: DailyMemoryGenerationInput,
  ) => Effect.Effect<DailyMemoryGenerationResult, TextGenerationError>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-memory-test-" });
    const baseDir = options.profile
      ? path.join(
          temporaryDir,
          options.profile === "nightly" ? ".tritonai-harness-nightly" : ".tritonai-harness",
        )
      : temporaryDir;
    const codexHome = path.join(baseDir, "codex");
    const calls: string[] = [];
    const generate =
      options.generate ??
      ((input: DailyMemoryGenerationInput) => Effect.succeed(summaryFor(input)));
    const settingsLayer =
      options.memoryEnabled === undefined
        ? ServerSettings.layerUnmanagedTest.pipe(Layer.provide(ServerSecretStore.layer))
        : ServerSettings.layerTest({
            memoryEnabled: options.memoryEnabled,
            providerInstances: {
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                config: { homePath: codexHome },
              },
            },
          });
    const layer = Layer.mergeAll(
      settingsLayer,
      Layer.mock(ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: DEVICE_ID,
          label: "Test Mac",
          platform: { os: "darwin", arch: "arm64" },
        } as unknown as ExecutionEnvironmentDescriptor),
      }),
      Layer.mock(TextGeneration)({
        generateDailyMemory: (input) =>
          Effect.sync(() => calls.push(input.day)).pipe(Effect.andThen(generate(input))),
      }),
    ).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    );
    return { baseDir, codexHome, calls, layer, fs, path };
  });

it.layer(NodeServices.layer)("DailyMemory", (it) => {
  it.effect(
    "serves captured project memory and bounded original updates, without crossing workspaces",
    () =>
      Effect.gen(function* () {
        const { layer } = yield* makeHarness({ memoryEnabled: true });
        yield* TestClock.setTime(NOW);
        yield* Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('other-project', 'Acme App', '/code/other', '[]', ${localIso(20, 9)}, ${localIso(20, 9)})`;
          const memory = yield* DailyMemory.make;
          yield* memory.runCatchUp;
          const own = yield* memory.getProjectMemory({ projectId: ProjectId.make("project-1") });
          assert.strictEqual(own.state, "ready");
          assert.include(own.markdown!, "Progress");
          assert.isTrue(
            own.recentUpdates.some((report) => report.text === "Fixed and opened PR 12."),
          );
          const other = yield* memory.getProjectMemory({
            projectId: ProjectId.make("other-project"),
          });
          assert.strictEqual(other.state, "pending");
          assert.deepStrictEqual(other.recentUpdates, []);
          yield* sql`UPDATE projection_projects SET title = 'Renamed app' WHERE project_id = 'project-1'`;
          const renamed = yield* memory.getProjectMemory({
            projectId: ProjectId.make("project-1"),
          });
          assert.strictEqual(renamed.markdown, own.markdown);
          yield* sql`UPDATE projection_projects SET deleted_at = ${localIso(29, 9)} WHERE project_id = 'project-1'`;
          const deleted = yield* memory
            .getProjectMemory({ projectId: ProjectId.make("project-1") })
            .pipe(Effect.flip);
          assert.strictEqual(deleted._tag, "ServerProjectMemoryError");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("summarizes new V2 activity once alongside retained history", () =>
    Effect.gen(function* () {
      const captured: DailyMemoryGenerationInput[] = [];
      const { layer, baseDir, codexHome, fs, path } = yield* makeHarness({
        memoryEnabled: true,
        generate: (input) =>
          Effect.sync(() => {
            captured.push(input);
            return summaryFor(input);
          }),
      });
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seed;
        yield* seedV2Activity({
          threadId: "thread-1",
          projectId: "project-1",
          title: "Upgraded login task",
          at: localIso(28, 10),
          messages: [
            { id: "m3", role: "user", text: "V2 authoritative request" },
            { id: "m4", role: "assistant", text: "Unfinished V2 response", streaming: true },
          ],
        });
        yield* seedV2Activity({
          threadId: "thread-v2",
          projectId: "project-1",
          title: "New V2 task",
          at: localIso(28, 12),
          messages: [{ id: "v2-only", role: "assistant", text: "V2-only assistant reply" }],
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES ('deleted-v2', 'project-1', 'V1 tombstone fallback', ${localIso(28, 10)}, ${localIso(28, 10)})`;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('deleted-v2-message', 'deleted-v2', 'user', 'Deleted V2 activity', 0, ${localIso(28, 10)}, ${localIso(28, 10)})`;
        yield* seedV2Activity({
          threadId: "deleted-v2",
          projectId: "project-1",
          title: "V2 tombstone",
          at: localIso(28, 10),
          deletedAt: localIso(28, 12),
          messages: [],
        });
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
          (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
          VALUES ('native-provider', 'thread-1', 'codex', 'ready', ${localIso(28, 10)},
            '{"nativeThreadRef":{"nativeId":"native-v2-session"}}')`;
        yield* sql`UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = 'native-provider' WHERE thread_id = 'thread-1'`;
        const nativeSession = path.join(
          codexHome,
          "sessions",
          "rollout-2026-09-28-native-v2-session.jsonl",
        );
        const staleSession = path.join(
          codexHome,
          "sessions",
          "rollout-2026-09-28-codex-thread-a.jsonl",
        );
        yield* fs.makeDirectory(path.dirname(nativeSession), { recursive: true });
        yield* fs.writeFileString(nativeSession, "{}\n");
        yield* fs.writeFileString(staleSession, "{}\n");
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        const day = captured.find((input) => input.day === "2026-09-28");
        assert.isDefined(day);
        assert.strictEqual(day!.activity.split("V2 authoritative request").length - 1, 1);
        assert.include(day!.activity, "V2-only assistant reply");
        assert.notInclude(day!.activity, "Fix it and open a PR.");
        assert.notInclude(day!.activity, "Unfinished V2 response");
        assert.notInclude(day!.activity, "Fixed and opened PR 12.");
        assert.notInclude(day!.activity, "Deleted V2 activity");
        const note = yield* fs.readFileString(
          files(path, path.join(baseDir, "memory", "general")).daily("2026-09-28"),
        );
        assert.include(note, nativeSession);
        assert.notInclude(note, staleSession);
      }).pipe(Effect.provide(layer));
    }),
  );

  describe.each(Array.from(["stable", "nightly"] as const, (scenario) => ({ scenario })))(
    "case $scenario",
    ({ scenario: profile }) => {
      // regression: 918a8176d3 enable memory automatically for existing installations
      it.effect(`automatically backfills a full week for an existing ${profile} installation`, () =>
        Effect.gen(function* () {
          const { baseDir, codexHome, calls, layer, fs, path } = yield* makeHarness({ profile });
          yield* TestClock.setTime(NOW);

          yield* Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            const settings = yield* ServerSettings.ServerSettingsService;
            const sql = yield* SqlClient.SqlClient;
            const legacySettings = yield* compiledEncodeUnknownEffect1({
              providerInstances: {
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  enabled: true,
                  config: { homePath: codexHome },
                },
              },
            });
            yield* fs.writeFileString(config.settingsPath, legacySettings);
            yield* seed;
            for (let day = 21; day <= 28; day++) {
              const at = localIso(day, 12);
              yield* sql`
              INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
              VALUES (${`history-${day}`}, 'thread-1', 'assistant', ${`Finished work on day ${day}.`}, 0, ${at}, ${at})
            `;
            }
            yield* settings.start;
            assert.isTrue((yield* settings.getSettings).memoryEnabled);

            const memory = yield* DailyMemory.make;
            yield* memory.runCatchUp;
            const vault = path.join(baseDir, "memory", "general");
            const vaultFiles = files(path, vault);
            // The last seven finished days, then today so far.
            assert.deepStrictEqual(calls, [
              "2026-09-22",
              "2026-09-23",
              "2026-09-24",
              "2026-09-25",
              "2026-09-26",
              "2026-09-27",
              "2026-09-28",
              "2026-09-29",
            ]);
            for (const day of calls) {
              assert.isTrue(yield* fs.exists(vaultFiles.daily(day)));
            }
            assert.isFalse(yield* fs.exists(vaultFiles.daily("2026-09-21")));
            assert.include(
              yield* fs.readFileString(vaultFiles.daily("2026-09-29")),
              "status: partial",
            );
            for (const directory of ["Projects", "Notes", "Inbox/3f2a/processed"]) {
              assert.isTrue(yield* fs.exists(path.join(vault, directory)));
            }
            assert.isTrue(yield* fs.exists(path.join(vault, "AGENTS.md")));
            assert.include(
              yield* fs.readFileString(path.join(vault, ".devices", DEVICE_ID, "device.json")),
              '"name": "Test Mac"',
            );
            assert.isTrue(
              yield* fs.exists(path.join(codexHome, "skills", memorySkillName(vault), "SKILL.md")),
            );

            yield* settings.start;
            yield* memory.runCatchUp;
            assert.lengthOf(calls, 8);
            assert.strictEqual((yield* memory.getStatus).lastSummarizedDay, "2026-09-28");
          }).pipe(Effect.provide(layer));
        }),
      );
    },
  );

  it.effect("catches up on finished days and links notes, threads, and inbox notes", () =>
    Effect.gen(function* () {
      const { baseDir, codexHome, calls, layer, fs, path } = yield* makeHarness({
        memoryEnabled: true,
      });
      const vault = path.join(baseDir, "memory", "general");
      const vaultFiles = files(path, vault);
      const sessionFile = path.join(
        codexHome,
        "sessions",
        "2026",
        "09",
        "26",
        "rollout-2026-09-26T10-00-00-codex-thread-a.jsonl",
      );
      yield* fs.makeDirectory(path.dirname(sessionFile), { recursive: true });
      yield* fs.writeFileString(sessionFile, "{}\n");
      yield* fs.makeDirectory(vaultFiles.inbox, { recursive: true });
      const inboxNote = path.join(vaultFiles.inbox, "2026-09-28-1200-login.md");
      yield* fs.writeFileString(inboxNote, "## Summary\n\nLogin fixed.\n");
      yield* fs.utimes(inboxNote, NOON_28, NOON_28);
      // Someone typed into the file this device is about to write.
      yield* fs.makeDirectory(path.dirname(vaultFiles.daily("2026-09-28")), { recursive: true });
      yield* fs.writeFileString(vaultFiles.daily("2026-09-28"), "# My own notes\n");
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;

        // Only days with live activity reach the model, then today so far.
        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-28", "2026-09-29"]);
        assert.isFalse(yield* fs.exists(vaultFiles.daily("2026-09-27")));

        const day28 = yield* fs.readFileString(vaultFiles.daily("2026-09-28"));
        assert.isTrue(day28.startsWith("---\ndate: 2026-09-28\n"));
        assert.include(day28, "status: final");
        assert.include(day28, `### [[Acme App - ${DEVICE}|Acme App]]`);
        assert.include(day28, `Session: \`${sessionFile}\``);
        assert.include(day28, `- Previous day: [[2026-09-26 ${DEVICE}]]`);
        assert.include(day28, "- Inbox: [[Inbox/3f2a/processed/2026-09-28/2026-09-28-1200-login]]");
        assert.notInclude(day28, "Deleted experiment");
        assert.strictEqual(
          yield* fs.readFileString(vaultFiles.recovered(`Daily/2026/2026-09-28 ${DEVICE}.md`)),
          "# My own notes\n",
        );
        assert.isFalse(yield* fs.exists(inboxNote));
        assert.isTrue(
          yield* fs.exists(
            path.join(vaultFiles.processed("2026-09-28"), "2026-09-28-1200-login.md"),
          ),
        );

        const project = yield* fs.readFileString(vaultFiles.project("Acme App"));
        assert.include(project, `- [[2026-09-26 ${DEVICE}]]: Progress 2026-09-26\n`);
        assert.include(project, `- [[2026-09-28 ${DEVICE}]]: Progress 2026-09-28\n`);

        const skill = yield* fs.readFileString(
          path.join(codexHome, "skills", memorySkillName(vault), "SKILL.md"),
        );
        assert.include(skill, vault);
        assert.include(skill, "Inbox/3f2a/YYYY-MM-DD-HHMM-short-topic.md");

        const status = yield* memory.getStatus;
        assert.strictEqual(status.state, "idle");
        assert.strictEqual(status.lastSummarizedDay, "2026-09-28");
        assert.strictEqual(status.generalDirectoryPath, vault);

        // Coverage starts at the first day the catch-up window examined and
        // lists the final note for each day with activity.
        const coverage = readCoverage(yield* fs.readFileString(vaultFiles.coverage));
        assert.strictEqual(coverage.coveredFrom, "2026-09-22");
        assert.strictEqual(coverage.lastSummarizedDay, "2026-09-28");
        assert.deepStrictEqual(Object.keys(coverage.notes), ["2026-09-26", "2026-09-28"]);
        assert.strictEqual(
          coverage.notes["2026-09-28"]?.path,
          `Daily/2026/2026-09-28 ${DEVICE}.md`,
        );

        // Caught up: later checks within four hours do nothing.
        yield* memory.runCatchUp;
        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-28", "2026-09-29"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  // regression: ec31417a1b keep loose inbox notes and drop day notes with nothing left to summarize
  it.effect("removes today's partial note when its only thread is deleted", () =>
    Effect.gen(function* () {
      const { baseDir, calls, layer, fs, path } = yield* makeHarness({ memoryEnabled: true });
      const vaultFiles = files(path, path.join(baseDir, "memory", "general"));
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        assert.include(yield* fs.readFileString(vaultFiles.daily("2026-09-29")), "status: partial");

        yield* sql`UPDATE projection_threads SET deleted_at = ${localIso(29, 10)} WHERE thread_id = 'thread-1'`;
        const callsBefore = calls.length;
        yield* TestClock.setTime(AFTER_MIDNIGHT_30);
        yield* memory.runCatchUp;
        // Nothing is left to summarize, so the model is not called.
        assert.lengthOf(calls, callsBefore);
        assert.isFalse(yield* fs.exists(vaultFiles.daily("2026-09-29")));
        const coverage = readCoverage(yield* fs.readFileString(vaultFiles.coverage));
        assert.strictEqual(coverage.lastSummarizedDay, "2026-09-29");
        assert.notProperty(coverage.notes, "2026-09-29");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("summarizing a day again keeps its inbox notes and one project line", () =>
    Effect.gen(function* () {
      let run = 0;
      const inboxSeen: string[] = [];
      const { baseDir, calls, layer, fs, path } = yield* makeHarness({
        memoryEnabled: true,
        generate: (input) =>
          Effect.sync(() => {
            if (input.day === "2026-09-28") {
              run++;
              inboxSeen.push(input.inboxNotes);
            }
            return {
              ...summaryFor(input),
              projects: input.projectNames.map((project) => ({
                project,
                workedOn: ["Progress."],
                recent: `Run ${run} on ${input.day}`,
              })),
            };
          }),
      });
      const vault = path.join(baseDir, "memory", "general");
      const vaultFiles = files(path, vault);
      yield* fs.makeDirectory(vaultFiles.inbox, { recursive: true });
      const inboxNote = path.join(vaultFiles.inbox, "2026-09-28-1200-login.md");
      yield* fs.writeFileString(inboxNote, "## Summary\n\nLogin fixed.\n");
      yield* fs.utimes(inboxNote, NOON_28, NOON_28);
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        // An interrupted run or a lost state file summarizes the day again.
        yield* fs.writeFileString(
          vaultFiles.coverage,
          '{"version":1,"lastSummarizedDay":"2026-09-27","coveredFrom":null,"notes":{}}\n',
        );
        yield* memory.runCatchUp;

        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-28", "2026-09-29", "2026-09-28"]);
        assert.include(inboxSeen[1], "Login fixed.");
        const day28 = yield* fs.readFileString(vaultFiles.daily("2026-09-28"));
        assert.include(day28, "- Inbox: [[Inbox/3f2a/processed/2026-09-28/2026-09-28-1200-login]]");
        assert.isFalse(
          yield* fs.exists(
            path.join(vaultFiles.processed("2026-09-28"), "2026-09-28-1200-login-2.md"),
          ),
        );
        // Harness wrote the note it replaced, so nothing is recovered.
        assert.isFalse(yield* fs.exists(path.join(vault, "Notes", "Recovered")));
        const project = yield* fs.readFileString(vaultFiles.project("Acme App"));
        assert.include(project, `- [[2026-09-28 ${DEVICE}]]: Run 2 on 2026-09-28\n`);
        assert.notInclude(project, "Run 1 on 2026-09-28");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps the failed day pending and reports the error", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness({
        memoryEnabled: true,
        generate: () =>
          Effect.fail(
            new TextGenerationError({ operation: "generateDailyMemory", detail: "model offline" }),
          ),
      });
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        const failed = yield* memory.getStatus;
        assert.strictEqual(failed.state, "error");
        assert.include(failed.message ?? "", "model offline");
        // Empty days before it are done; the failing day is not, and today waits.
        assert.strictEqual(failed.lastSummarizedDay, "2026-09-25");

        // The next check retries the same day rather than skipping it.
        yield* memory.runCatchUp;
        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-26"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  // regression: 8fa2a69b2f keep same-titled projects apart and defer inbox notes that do not fit
  it.effect("gives same-titled projects in different workspaces their own notes", () =>
    Effect.gen(function* () {
      const activityByDay = new Map<string, string>();
      const { baseDir, layer, fs, path } = yield* makeHarness({
        memoryEnabled: true,
        generate: (input) =>
          Effect.sync(() => {
            activityByDay.set(input.day, input.activity);
            return summaryFor(input);
          }),
      });
      const vaultFiles = files(path, path.join(baseDir, "memory", "general"));
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const created = localIso(20, 9);
        yield* sql`
          INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('project-2', 'Acme App', '/forks/acme', '[]', ${created}, ${created})
        `;
        yield* sql`
          INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES ('thread-3', 'project-2', 'Fork cleanup', ${created}, ${created})
        `;
        const at = localIso(28, 12);
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m7', 'thread-3', 'turn-m7', 'user', 'Clean up the fork.', 0, ${at}, ${at})
        `;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;

        const original = yield* fs.readFileString(vaultFiles.project("Acme App"));
        const fork = yield* fs.readFileString(vaultFiles.project("Acme App (forks)"));
        assert.include(original, 'workspace: "/code/acme"');
        assert.include(original, `- [[2026-09-28 ${DEVICE}]]: Progress 2026-09-28\n`);
        assert.include(fork, 'workspace: "/forks/acme"');
        assert.include(fork, `- [[2026-09-28 ${DEVICE}]]: Progress 2026-09-28\n`);
        const day28 = yield* fs.readFileString(vaultFiles.daily("2026-09-28"));
        assert.include(
          day28,
          `**Fork cleanup** in [[Acme App (forks) - ${DEVICE}|Acme App (forks)]]`,
        );
        // The model sees which note each thread belongs to.
        const day28Activity = activityByDay.get("2026-09-28") ?? "";
        assert.include(day28Activity, "## Thread: Fork cleanup\nProject: Acme App (forks)");
        assert.include(day28Activity, "## Thread: Fix the login redirect\nProject: Acme App\n");
      }).pipe(Effect.provide(layer));
    }),
  );

  // regression: 8fa2a69b2f keep same-titled projects apart and defer inbox notes that do not fit
  it.effect("leaves inbox notes that did not fit in the summary for the next one", () =>
    Effect.gen(function* () {
      const inboxByDay = new Map<string, string>();
      const { baseDir, layer, fs, path } = yield* makeHarness({
        memoryEnabled: true,
        generate: (input) =>
          Effect.sync(() => {
            inboxByDay.set(input.day, input.inboxNotes);
            return summaryFor(input);
          }),
      });
      const vaultFiles = files(path, path.join(baseDir, "memory", "general"));
      yield* fs.makeDirectory(vaultFiles.inbox, { recursive: true });
      for (const name of ["a", "b", "c"]) {
        const note = path.join(vaultFiles.inbox, `2026-09-28-1200-${name}.md`);
        yield* fs.writeFileString(note, `${name.repeat(7_000)}\n`);
        yield* fs.utimes(note, NOON_28, NOON_28);
      }
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;

        const day28Input = inboxByDay.get("2026-09-28") ?? "";
        assert.include(day28Input, "a".repeat(7_000));
        assert.include(day28Input, "b".repeat(7_000));
        assert.notInclude(day28Input, "c".repeat(7_000));
        // Today's note picks up the one that did not fit.
        assert.include(inboxByDay.get("2026-09-29") ?? "", "c".repeat(7_000));
        assert.isTrue(
          yield* fs.exists(path.join(vaultFiles.processed("2026-09-29"), "2026-09-28-1200-c.md")),
        );
        assert.isTrue(
          yield* fs.exists(path.join(vaultFiles.processed("2026-09-28"), "2026-09-28-1200-a.md")),
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  // regression: 8097499d11 wait for streaming turns before summarizing a day
  it.effect("waits for a day whose turn is still streaming, unless it was abandoned", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness({ memoryEnabled: true });
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const startedAt = localIso(28, 23);
        const recently = DateTime.formatIso(DateTime.makeUnsafe(NOW - 10 * 60_000));
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m8', 'thread-1', 'turn-m8', 'assistant', 'Still working', 1, ${startedAt}, ${recently})
        `;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        // Today waits until every finished day is written.
        assert.deepStrictEqual(calls, ["2026-09-26"]);
        assert.strictEqual((yield* memory.getStatus).lastSummarizedDay, "2026-09-27");

        const longAgo = DateTime.formatIso(DateTime.makeUnsafe(NOW - 3 * 60 * 60_000));
        yield* sql`UPDATE projection_thread_messages SET updated_at = ${longAgo} WHERE message_id = 'm8'`;
        yield* memory.runCatchUp;
        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-28", "2026-09-29"]);
        assert.strictEqual((yield* memory.getStatus).lastSummarizedDay, "2026-09-28");
      }).pipe(Effect.provide(layer));
    }),
  );

  // regression: 2b1d09f266 record which days memory covered so agents do not read gaps as idle days
  it.effect("restarts coverage after a gap longer than the catch-up window", () =>
    Effect.gen(function* () {
      const { baseDir, layer, fs, path } = yield* makeHarness({ memoryEnabled: true });
      const coverageFile = files(path, path.join(baseDir, "memory", "general")).coverage;
      yield* fs.makeDirectory(path.dirname(coverageFile), { recursive: true });
      yield* fs.writeFileString(
        coverageFile,
        '{"version":1,"coveredFrom":"2026-09-01","lastSummarizedDay":"2026-09-10","notes":{"2026-09-05":{"path":"Daily/2026/old.md","sha256":"x"}}}\n',
      );
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        const coverage = readCoverage(yield* fs.readFileString(coverageFile));
        // 11 to 21 September were never examined, so they are not claimed as empty.
        assert.strictEqual(coverage.coveredFrom, "2026-09-22");
        assert.strictEqual(coverage.lastSummarizedDay, "2026-09-28");
        assert.deepStrictEqual(Object.keys(coverage.notes), ["2026-09-26", "2026-09-28"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("stops catching up after the current day when Memory is turned off", () =>
    Effect.gen(function* () {
      let turnOff: Effect.Effect<void> = Effect.void;
      const { calls, layer } = yield* makeHarness({
        memoryEnabled: true,
        generate: (input) => turnOff.pipe(Effect.as(summaryFor(input))),
      });
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const settings = yield* ServerSettings.ServerSettingsService;
        turnOff = settings
          .updateSettings({ memoryEnabled: false })
          .pipe(Effect.asVoid, Effect.orDie);
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;

        assert.deepStrictEqual(calls, ["2026-09-26"]);
        assert.strictEqual((yield* memory.getStatus).lastSummarizedDay, "2026-09-26");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("writes nothing while off and removes its skill when turned off", () =>
    Effect.gen(function* () {
      const { baseDir, codexHome, calls, layer, fs, path } = yield* makeHarness({
        memoryEnabled: true,
      });
      yield* TestClock.setTime(NOW);
      const skillFile = path.join(
        codexHome,
        "skills",
        memorySkillName(path.join(baseDir, "memory", "general")),
        "SKILL.md",
      );

      yield* Effect.gen(function* () {
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        assert.isTrue(yield* fs.exists(skillFile));

        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ memoryEnabled: false });
        yield* memory.runCatchUp;
        assert.isFalse(yield* fs.exists(skillFile));
        const status = yield* memory.getStatus;
        assert.strictEqual(status.state, "disabled");
        assert.isFalse(status.enabled);
      }).pipe(Effect.provide(layer));

      const off = yield* makeHarness({ memoryEnabled: false });
      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
      }).pipe(Effect.provide(off.layer));
      assert.isFalse(yield* fs.exists(path.join(off.baseDir, "memory")));
      assert.deepStrictEqual(off.calls, []);
      assert.deepStrictEqual(calls, []);
      assert.isTrue(yield* fs.exists(baseDir));
    }),
  );
});

const compiledEncodeUnknownEffect1 = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown),
);
