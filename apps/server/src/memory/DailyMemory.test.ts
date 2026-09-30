// @effect-diagnostics globalDate:off - fixtures are built from host-local times.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { TextGenerationError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
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
            providers: { codex: { homePath: codexHome } },
          });
    const layer = Layer.mergeAll(
      settingsLayer,
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
  for (const profile of ["stable", "nightly"] as const) {
    it.effect(`automatically backfills a full week for an existing ${profile} installation`, () =>
      Effect.gen(function* () {
        const { baseDir, codexHome, calls, layer, fs, path } = yield* makeHarness({ profile });
        yield* TestClock.setTime(NOW);

        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const settings = yield* ServerSettings.ServerSettingsService;
          const sql = yield* SqlClient.SqlClient;
          const legacySettings = yield* Schema.encodeUnknownEffect(
            Schema.fromJsonString(Schema.Unknown),
          )({ providers: { codex: { homePath: codexHome } } });
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
          assert.deepStrictEqual(calls, [
            "2026-09-22",
            "2026-09-23",
            "2026-09-24",
            "2026-09-25",
            "2026-09-26",
            "2026-09-27",
            "2026-09-28",
          ]);
          for (const day of calls) {
            assert.isTrue(yield* fs.exists(path.join(vault, "Daily", `${day}.md`)));
          }
          assert.isFalse(yield* fs.exists(path.join(vault, "Daily", "2026-09-21.md")));
          assert.isFalse(yield* fs.exists(path.join(vault, "Daily", "2026-09-29.md")));
          for (const directory of ["Projects", "Inbox", "Inbox/processed"]) {
            assert.isTrue(yield* fs.exists(path.join(vault, directory)));
          }
          assert.isTrue(yield* fs.exists(path.join(vault, "AGENTS.md")));
          assert.isTrue(
            yield* fs.exists(path.join(codexHome, "skills", memorySkillName(vault), "SKILL.md")),
          );

          yield* settings.start;
          yield* memory.runCatchUp;
          assert.lengthOf(calls, 7);
          assert.strictEqual((yield* memory.getStatus).lastSummarizedDay, "2026-09-28");
        }).pipe(Effect.provide(layer));
      }),
    );
  }

  it.effect("catches up on finished days and links notes, threads, and inbox notes", () =>
    Effect.gen(function* () {
      const { baseDir, codexHome, calls, layer, fs, path } = yield* makeHarness({
        memoryEnabled: true,
      });
      const vault = path.join(baseDir, "memory", "general");
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
      yield* fs.makeDirectory(path.join(vault, "Inbox"), { recursive: true });
      yield* fs.makeDirectory(path.join(vault, "Daily"), { recursive: true });
      const inboxNote = path.join(vault, "Inbox", "2026-09-28-1200-login.md");
      yield* fs.writeFileString(inboxNote, "## Summary\n\nLogin fixed.\n");
      yield* fs.utimes(inboxNote, NOON_28, NOON_28);
      yield* fs.writeFileString(path.join(vault, "Daily", "2026-09-28.md"), "# My own notes\n");
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;

        // Only days with live activity reach the model; today waits.
        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-28"]);
        assert.isFalse(yield* fs.exists(path.join(vault, "Daily", "2026-09-27.md")));

        const day28 = yield* fs.readFileString(path.join(vault, "Daily", "2026-09-28.md"));
        assert.isTrue(day28.startsWith("# My own notes\n\n---\n\n---\ndate: 2026-09-28"));
        assert.include(day28, "### [[Acme App]]");
        assert.include(day28, `Session: \`${sessionFile}\``);
        assert.include(day28, "- Previous day: [[Daily/2026-09-26]]");
        assert.include(day28, "- Inbox: [[Inbox/processed/2026-09-28/2026-09-28-1200-login]]");
        assert.notInclude(day28, "Deleted experiment");
        assert.isFalse(yield* fs.exists(inboxNote));
        assert.isTrue(
          yield* fs.exists(
            path.join(vault, "Inbox", "processed", "2026-09-28", "2026-09-28-1200-login.md"),
          ),
        );

        const project = yield* fs.readFileString(path.join(vault, "Projects", "Acme App.md"));
        assert.include(project, "## Pinned");
        assert.include(project, "- [[Daily/2026-09-26]]: Progress 2026-09-26\n");
        assert.include(project, "- [[Daily/2026-09-28]]: Progress 2026-09-28\n");

        const skill = yield* fs.readFileString(
          path.join(codexHome, "skills", memorySkillName(vault), "SKILL.md"),
        );
        assert.include(skill, vault);

        const status = yield* memory.getStatus;
        assert.strictEqual(status.state, "idle");
        assert.strictEqual(status.lastSummarizedDay, "2026-09-28");
        assert.strictEqual(status.generalDirectoryPath, vault);

        // Coverage starts at the first day the catch-up window examined.
        const state = yield* fs.readFileString(path.join(vault, ".state", "daily-summary.json"));
        assert.include(state, '"coveredFrom": "2026-09-22"');
        assert.include(state, '"lastSummarizedDay": "2026-09-28"');

        // Caught up: later checks the same day do nothing.
        yield* memory.runCatchUp;
        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-28"]);
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
      yield* fs.makeDirectory(path.join(vault, "Inbox"), { recursive: true });
      const inboxNote = path.join(vault, "Inbox", "2026-09-28-1200-login.md");
      yield* fs.writeFileString(inboxNote, "## Summary\n\nLogin fixed.\n");
      yield* fs.utimes(inboxNote, NOON_28, NOON_28);
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        // An interrupted run or a lost state file summarizes the day again.
        yield* fs.writeFileString(
          path.join(vault, ".state", "daily-summary.json"),
          '{"version":1,"lastSummarizedDay":"2026-09-27"}\n',
        );
        yield* memory.runCatchUp;

        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-28", "2026-09-28"]);
        assert.include(inboxSeen[1], "Login fixed.");
        const day28 = yield* fs.readFileString(path.join(vault, "Daily", "2026-09-28.md"));
        assert.include(day28, "- Inbox: [[Inbox/processed/2026-09-28/2026-09-28-1200-login]]");
        assert.isFalse(
          yield* fs.exists(
            path.join(vault, "Inbox", "processed", "2026-09-28", "2026-09-28-1200-login-2.md"),
          ),
        );
        const project = yield* fs.readFileString(path.join(vault, "Projects", "Acme App.md"));
        assert.include(project, "- [[Daily/2026-09-28]]: Run 2 on 2026-09-28\n");
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
        // Empty days before it are done; the failing day is not.
        assert.strictEqual(failed.lastSummarizedDay, "2026-09-25");

        // The next check retries the same day rather than skipping it.
        yield* memory.runCatchUp;
        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-26"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("gives same-titled projects in different workspaces their own notes", () =>
    Effect.gen(function* () {
      const activitySeen: string[] = [];
      const { baseDir, layer, fs, path } = yield* makeHarness({
        memoryEnabled: true,
        generate: (input) =>
          Effect.sync(() => {
            activitySeen.push(input.activity);
            return summaryFor(input);
          }),
      });
      const vault = path.join(baseDir, "memory", "general");
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

        const original = yield* fs.readFileString(path.join(vault, "Projects", "Acme App.md"));
        const fork = yield* fs.readFileString(path.join(vault, "Projects", "Acme App (forks).md"));
        assert.include(original, 'workspace: "/code/acme"');
        assert.include(original, "- [[Daily/2026-09-28]]: Progress 2026-09-28\n");
        assert.include(fork, 'workspace: "/forks/acme"');
        assert.include(fork, "- [[Daily/2026-09-28]]: Progress 2026-09-28\n");
        const day28 = yield* fs.readFileString(path.join(vault, "Daily", "2026-09-28.md"));
        assert.include(day28, "**Fork cleanup** in [[Acme App (forks)]]");
        // The model sees which note each thread belongs to.
        const day28Activity = activitySeen.at(-1) ?? "";
        assert.include(day28Activity, "## Thread: Fork cleanup\nProject: Acme App (forks)");
        assert.include(day28Activity, "## Thread: Fix the login redirect\nProject: Acme App\n");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("leaves inbox notes that did not fit in the summary for the next one", () =>
    Effect.gen(function* () {
      const inboxSeen: string[] = [];
      const { baseDir, layer, fs, path } = yield* makeHarness({
        memoryEnabled: true,
        generate: (input) =>
          Effect.sync(() => {
            inboxSeen.push(input.inboxNotes);
            return summaryFor(input);
          }),
      });
      const vault = path.join(baseDir, "memory", "general");
      yield* fs.makeDirectory(path.join(vault, "Inbox"), { recursive: true });
      for (const name of ["a", "b", "c"]) {
        const note = path.join(vault, "Inbox", `2026-09-28-1200-${name}.md`);
        yield* fs.writeFileString(note, `${name.repeat(7_000)}\n`);
        yield* fs.utimes(note, NOON_28, NOON_28);
      }
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;

        const day28Input = inboxSeen.at(-1) ?? "";
        assert.include(day28Input, "a".repeat(7_000));
        assert.include(day28Input, "b".repeat(7_000));
        assert.notInclude(day28Input, "c".repeat(7_000));
        assert.isTrue(yield* fs.exists(path.join(vault, "Inbox", "2026-09-28-1200-c.md")));
        assert.isFalse(yield* fs.exists(path.join(vault, "Inbox", "2026-09-28-1200-a.md")));
      }).pipe(Effect.provide(layer));
    }),
  );

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
        assert.deepStrictEqual(calls, ["2026-09-26"]);
        assert.strictEqual((yield* memory.getStatus).lastSummarizedDay, "2026-09-27");

        const longAgo = DateTime.formatIso(DateTime.makeUnsafe(NOW - 3 * 60 * 60_000));
        yield* sql`UPDATE projection_thread_messages SET updated_at = ${longAgo} WHERE message_id = 'm8'`;
        yield* memory.runCatchUp;
        assert.deepStrictEqual(calls, ["2026-09-26", "2026-09-28"]);
        assert.strictEqual((yield* memory.getStatus).lastSummarizedDay, "2026-09-28");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("restarts coverage after a gap longer than the catch-up window", () =>
    Effect.gen(function* () {
      const { baseDir, layer, fs, path } = yield* makeHarness({ memoryEnabled: true });
      const stateFile = path.join(baseDir, "memory", "general", ".state", "daily-summary.json");
      yield* fs.makeDirectory(path.dirname(stateFile), { recursive: true });
      yield* fs.writeFileString(
        stateFile,
        '{"version":1,"coveredFrom":"2026-09-01","lastSummarizedDay":"2026-09-10"}\n',
      );
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        yield* seed;
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
        const state = yield* fs.readFileString(stateFile);
        // 11 to 21 September were never examined, so they are not claimed as empty.
        assert.include(state, '"coveredFrom": "2026-09-22"');
        assert.include(state, '"lastSummarizedDay": "2026-09-28"');
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

  it.effect("leaves a same-named skill it did not write alone", () =>
    Effect.gen(function* () {
      const { baseDir, codexHome, layer, fs, path } = yield* makeHarness({ memoryEnabled: false });
      const skillFile = path.join(
        codexHome,
        "skills",
        memorySkillName(path.join(baseDir, "memory", "general")),
        "SKILL.md",
      );
      yield* fs.makeDirectory(path.dirname(skillFile), { recursive: true });
      yield* fs.writeFileString(skillFile, "---\nname: tritonai-memory\n---\nMine.\n");
      yield* TestClock.setTime(NOW);

      yield* Effect.gen(function* () {
        const memory = yield* DailyMemory.make;
        yield* memory.runCatchUp;
      }).pipe(Effect.provide(layer));
      assert.strictEqual(
        yield* fs.readFileString(skillFile),
        "---\nname: tritonai-memory\n---\nMine.\n",
      );
    }),
  );
});
