// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off - fixtures use host-local times and read the record directly.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type TeamDailyMemoryGenerationInput,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import { MAX_CATCH_UP_DAYS, PARTIAL_INTERVAL_MS, STREAMING_GRACE_HOURS } from "./DailyMemory.ts";
import { teamDailyPath } from "./teamDaily.ts";
import { makeTeamDailyPass } from "./teamDailyPass.ts";
import type {
  TeamDailyAccount,
  TeamDailySource,
  TeamDailyWorkspace,
  TeamDailyWrite,
} from "./teamDailySource.ts";

const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
const dayOf = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;
const ALICE = "a".repeat(43);
const BOB = "b".repeat(43);
const TEAM_A = "11111111-1111-4111-8111-111111111111";
const TEAM_B = "22222222-2222-4222-8222-222222222222";

/** A Teams side whose access, links, folders, and storage the test controls. */
function fakeTeams() {
  /** Files by `<folder>/<team>/<path>`. */
  const files = new Map<string, { text: string; etag: string }>();
  const allWrites: Array<{ teamId: string; path: string; text: string | null }> = [];
  /** Writes of daily notes, without change markers. */
  const writes = {
    get length() {
      return allWrites.filter((write) => write.path.endsWith(".md")).length;
    },
    some: (test: (write: (typeof allWrites)[number]) => boolean) =>
      allWrites.some((write) => write.path.endsWith(".md") && test(write)),
    every: (test: (write: (typeof allWrites)[number]) => boolean) => allWrites.every(test),
  };
  let version = 0;
  const state = {
    account: {
      kind: "signed-in",
      author: ALICE,
      authorName: "Alice",
      workspaces: [] as TeamDailyWorkspace[],
    } as TeamDailyAccount,
    /** Each team's current folder. */
    roots: new Map<string, string>(),
    /** Answers the next writes with this instead of writing. */
    hold: null as TeamDailyWrite | null,
    /** Holds writes to paths that match, as an outage between two requests would. */
    holdPaths: null as RegExp | null,
    /** Writes to paths that match land, but their answer is lost, as after a crash. */
    landThenLose: null as RegExp | null,
    /** Refuses writes to paths that match, as a write that can never succeed. */
    rejectPaths: null as RegExp | null,
    /** Reading files fails, as when the file can't be reached. */
    inspectHeld: false,
    /** Stands in for the account, token, and membership checks the real write awaits. */
    beforeRequest: Effect.void as Effect.Effect<void>,
  };
  const rootOf = (teamId: string) => state.roots.get(teamId) ?? "root-1";
  const workspaces = () => (state.account.kind === "signed-in" ? state.account.workspaces : []);
  const source: TeamDailySource = {
    account: () =>
      Effect.sync(() => {
        const account = structuredClone(state.account);
        return account.kind === "signed-in"
          ? {
              ...account,
              workspaces: account.workspaces.map((entry) => ({
                ...entry,
                storageKey: entry.access === "ready" ? rootOf(entry.teamId) : null,
              })),
            }
          : account;
      }),
    write: (input) =>
      Effect.gen(function* () {
        yield* state.beforeRequest;
        // As the real write does, sharing is checked last, just before the request.
        if (!(yield* input.stillShared))
          return { kind: "held", message: "Sharing changed." } satisfies TeamDailyWrite;
        return yield* Effect.sync((): TeamDailyWrite => {
          if (state.hold) return state.hold;
          if (state.holdPaths?.test(input.path)) return { kind: "held", message: "offline" };
          if (state.rejectPaths?.test(input.path))
            return { kind: "rejected", message: "Too large." };
          const workspace = workspaces().find((entry) => entry.teamId === input.teamId);
          if (!workspace || workspace.access === "lost") return { kind: "lost" };
          if (workspace.access === "held") return { kind: "held", message: "offline" };
          const root = rootOf(input.teamId);
          if (input.storageKey !== null && input.storageKey !== root)
            return { kind: "rejected", message: "The team's folder changed." };
          // The send-time link check: new text needs the same link it was summarized under.
          for (const fresh of input.freshProjects)
            if (
              !workspace.projects.some(
                (p) => p.projectId === fresh.projectId && p.sharingSince === fresh.sharingSince,
              )
            )
              return { kind: "held", message: "A project link changed." };
          const key = `${root}/${input.teamId}/${input.path}`;
          allWrites.push({ teamId: input.teamId, path: input.path, text: input.text });
          const lost = state.landThenLose?.test(input.path) ?? false;
          if (input.text === null) {
            files.delete(key);
            return lost
              ? { kind: "held", message: "No answer." }
              : { kind: "written", etag: null, storageKey: root };
          }
          const etag = `v${++version}`;
          files.set(key, { text: input.text, etag });
          return lost
            ? { kind: "held", message: "No answer." }
            : { kind: "written", etag, storageKey: root };
        });
      }),
    inspect: (input) =>
      Effect.sync(() => {
        if (state.inspectHeld) return { kind: "held", message: "Unreachable." } as const;
        const root = rootOf(input.teamId);
        if (input.storageKey !== null && input.storageKey !== root)
          return { kind: "held", message: "The team's folder changed." } as const;
        const file = files.get(`${root}/${input.teamId}/${input.path}`);
        return file ? ({ kind: "file", ...file } as const) : ({ kind: "missing" } as const);
      }),
  };
  const workspace = (
    teamId: string,
    projects: Array<[string, string]>,
    access: TeamDailyWorkspace["access"] = "ready",
  ): TeamDailyWorkspace => ({
    teamId,
    teamName: teamId === TEAM_A ? "Alpha" : "Beta",
    access,
    projects: projects.map(([projectId, sharingSince]) => ({ projectId, sharingSince })),
    storageKey: null,
  });
  const inRoot = (teamId: string, root?: string) => `${root ?? rootOf(teamId)}/${teamId}/`;
  return {
    files,
    writes,
    allWrites,
    state,
    source,
    workspace,
    setWorkspaces: (next: TeamDailyWorkspace[]) => {
      if (state.account.kind === "signed-in")
        state.account = { ...state.account, workspaces: next };
    },
    file: (teamId: string, day: string, deviceId: string, author = ALICE, root?: string) =>
      files.get(`${inRoot(teamId, root)}${teamDailyPath(author, day, deviceId)}`)?.text ?? null,
    /** Daily notes only, without change markers. */
    teamFiles: (teamId: string, root?: string) =>
      [...files.entries()]
        .filter(([key]) => key.startsWith(inRoot(teamId, root)) && key.endsWith(".md"))
        .map(([key, file]) => [key.slice(inRoot(teamId, root).length), file] as const)
        .map(([key, file]) => [`${teamId}/${key}`, file] as const),
    /** Changes a file directly in SharePoint, as a teammate could. */
    editRemote: (teamId: string, day: string, deviceId: string, text: string, root?: string) =>
      files.set(`${inRoot(teamId, root)}${teamDailyPath(ALICE, day, deviceId)}`, {
        text,
        etag: `edited-${++version}`,
      }),
    marker: (teamId: string, deviceId: string, author = ALICE, root?: string) =>
      files.get(`${inRoot(teamId, root)}Daily/${author}/${deviceId}.changes.json`)?.text ?? null,
  };
}

const seedProject = (projectId: string, title: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const created = at(1, 9);
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, ${title}, ${`/code/${projectId}`}, '[]', ${created}, ${created})
    `;
  });
const seedThread = (threadId: string, projectId: string, title: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const created = at(1, 9);
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${threadId}, ${projectId}, ${title}, ${created}, ${created})
    `;
  });
let messageCount = 0;
const say = (threadId: string, text: string, createdAt: string, role = "user") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = `m${++messageCount}`;
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${id}, ${threadId}, ${`turn-${id}`}, ${role}, ${text}, 0, ${createdAt}, ${createdAt})
    `;
  });
const setSharing = (threadId: string, shared: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE projection_threads SET team_sharing_off_at = ${shared ? null : at(1, 9)}
      WHERE thread_id = ${threadId}
    `;
  });

/** Share this thread again, as the decider records it. */
const reshare = (threadId: string, resumedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE projection_threads SET team_sharing_off_at = NULL, team_sharing_resumed_at = ${resumedAt}
      WHERE thread_id = ${threadId}
    `;
  });
const deleteThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_threads SET deleted_at = ${at(1, 9)} WHERE thread_id = ${threadId}`;
  });

/** Lets hooks that run outside the test's layer change the test's database. */
const sqlHolder: { current?: SqlClient.SqlClient } = {};
const withSql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.suspend(() =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sqlHolder.current!)),
  ).pipe(Effect.orDie, Effect.asVoid);

/** Echoes each thread's activity as its summary, so files show exactly what the model saw. */
const makeHarness = (options: {
  readonly memoryEnabled?: boolean;
  readonly during?: (input: TeamDailyMemoryGenerationInput) => Effect.Effect<void>;
  readonly fail?: () => boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-memory-test-" });
    const prompts: TeamDailyMemoryGenerationInput[] = [];
    const generate = (input: TeamDailyMemoryGenerationInput) =>
      Effect.gen(function* () {
        prompts.push(input);
        if (options.fail?.())
          return yield* new TextGenerationError({
            operation: "generateTeamDailyMemory",
            detail: "The model is unavailable.",
          });
        if (options.during) yield* options.during(input);
        return {
          threads: input.threads.map((thread) => ({
            key: thread.key,
            summary: thread.activity.replace(/\s+/gu, " "),
            items: [{ kind: "outcome" as const, text: "Finished." }],
          })),
        };
      });
    const layer = Layer.mergeAll(
      ServerSettings.layerTest({ memoryEnabled: options.memoryEnabled ?? true }),
      Layer.mock(TextGeneration)({ generateTeamDailyMemory: generate }),
    ).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    );
    return { baseDir, prompts, layer, path };
  });

const makePass = (stateDir: string) =>
  Effect.gen(function* () {
    return yield* makeTeamDailyPass({
      stateDir,
      deviceLabel: "Test Mac",
      settings: yield* ServerSettings.ServerSettingsService,
      textGeneration: yield* TextGeneration,
      maxCatchUpDays: MAX_CATCH_UP_DAYS,
      partialIntervalMs: PARTIAL_INTERVAL_MS,
      streamingGraceMs: STREAMING_GRACE_HOURS * 60 * 60_000,
    });
  });

const deviceIdOf = (stateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(path.join(stateDir, "team-daily", "state.json"));
    return (JSON.parse(raw) as { deviceId: string }).deviceId;
  });

/** The section the device's record keeps for a thread on a day. */
const sectionOf = (stateDir: string, teamId: string, day: string, threadId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(path.join(stateDir, "team-daily", "state.json"));
    const state = JSON.parse(raw) as {
      teams: Record<
        string,
        {
          days: Record<
            string,
            {
              sections: Record<string, { publishedText: string | null; owesRemoval?: boolean }>;
            }
          >;
        }
      >;
    };
    return state.teams[teamId]?.days[day]?.sections[threadId] ?? null;
  });
/** A turn still being written. */
const streaming = (threadId: string, createdAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = `m${++messageCount}`;
    yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${id}, ${threadId}, ${`turn-${id}`}, 'assistant', 'partial', 1, ${createdAt}, ${createdAt})
    `;
  });

/** Project Alpha 1 and 2 link to team A, Beta to team B, and Personal links nowhere. */
const seedWorld = Effect.gen(function* () {
  yield* seedProject("p-a1", "Alpha One");
  yield* seedProject("p-a2", "Alpha Two");
  yield* seedProject("p-b", "Beta Work");
  yield* seedProject("p-personal", "Personal");
  yield* seedThread("t-a1", "p-a1", "Alpha thread");
  yield* seedThread("t-a1-other", "p-a1", "Second alpha thread");
  yield* seedThread("t-a2", "p-a2", "Alpha two thread");
  yield* seedThread("t-b", "p-b", "Beta thread");
  yield* seedThread("t-personal", "p-personal", "Personal thread");
});

it.layer(NodeServices.layer)("team daily memory", (it) => {
  it.effect(
    "summarizes only each team's linked work after its link, never personal or earlier work",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
          yield* seedWorld;
          yield* say("t-a1", "before-link alpha", at(10, 8));
          yield* say("t-a1", "alpha work", at(10, 12));
          yield* say("t-b", "beta work", at(10, 12));
          yield* say("t-personal", "personal secret", at(10, 12));
          const teams = fakeTeams();
          teams.setWorkspaces([
            teams.workspace(TEAM_A, [["p-a1", at(10, 10)]]),
            teams.workspace(TEAM_B, [["p-b", at(1, 9)]]),
          ]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;

          const seen = harness.prompts.map((prompt) =>
            prompt.threads.map((t) => t.activity).join(),
          );
          assert.isFalse(seen.some((text) => text.includes("personal secret")));
          assert.isFalse(seen.some((text) => text.includes("before-link alpha")));
          const device = yield* deviceIdOf(harness.baseDir);
          const alpha = teams.file(TEAM_A, dayOf(10), device)!;
          const beta = teams.file(TEAM_B, dayOf(10), device)!;
          assert.include(alpha, "alpha work");
          assert.notInclude(alpha, "beta work");
          assert.include(alpha, "Thread: t-a1");
          assert.include(alpha, "status: partial");
          assert.include(beta, "beta work");
          assert.notInclude(beta, "alpha work");
          // One file per author, device, and day.
          assert.deepStrictEqual(
            teams.teamFiles(TEAM_A).map(([key]) => key),
            [`${TEAM_A}/Daily/${ALICE}/2026-10/2026-10-10 ${device}.md`],
          );
          // An unchanged day writes nothing again.
          const writes = teams.writes.length;
          yield* pass.run;
          assert.strictEqual(teams.writes.length, writes);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("leaves out a thread chosen as Don't share before or while the model runs", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        during: (input) =>
          input.threads.some((thread) => thread.activity.includes("racing work"))
            ? withSql(setSharing("t-a1-other", false))
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        sqlHolder.current = yield* SqlClient.SqlClient;
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "kept work", at(10, 12));
        yield* say("t-a1-other", "racing work", at(10, 12));
        yield* say("t-a2", "never shared", at(10, 12));
        yield* setSharing("t-a2", false);
        const teams = fakeTeams();
        teams.setWorkspaces([
          teams.workspace(TEAM_A, [
            ["p-a1", at(1, 9)],
            ["p-a2", at(1, 9)],
          ]),
        ]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;

        assert.isFalse(
          harness.prompts.some((prompt) =>
            prompt.threads.some((t) => t.activity.includes("never shared")),
          ),
        );
        const text = teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!;
        assert.include(text, "kept work");
        assert.notInclude(text, "racing work");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("drops a summary whose project was unlinked while the model ran", () =>
    Effect.gen(function* () {
      const teams = fakeTeams();
      const harness = yield* makeHarness({
        during: () =>
          Effect.sync(() => teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a2", at(1, 9)]])])),
      });
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "unlinked mid-model", at(10, 12));
        teams.setWorkspaces([
          teams.workspace(TEAM_A, [
            ["p-a1", at(1, 9)],
            ["p-a2", at(1, 9)],
          ]),
        ]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        assert.strictEqual(teams.writes.length, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "never publishes held text from a project unlinked before the retry, even from before the unlink",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
          yield* seedWorld;
          yield* say("t-a1", "held alpha work", at(10, 12));
          yield* say("t-a2", "linked alpha two", at(10, 12));
          const teams = fakeTeams();
          teams.setWorkspaces([
            teams.workspace(TEAM_A, [
              ["p-a1", at(1, 9)],
              ["p-a2", at(1, 9)],
            ]),
          ]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          teams.state.hold = { kind: "held", message: "Microsoft is offline." };
          yield* pass.run;
          assert.strictEqual(teams.writes.length, 0);

          // The project is unlinked while the upload waits; its work predates the unlink.
          teams.state.hold = null;
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a2", at(1, 9)]])]);
          yield* pass.run;
          const text = teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!;
          assert.include(text, "linked alpha two");
          assert.notInclude(text, "held alpha work");
          // Linking it again later doesn't bring the dropped text back.
          teams.setWorkspaces([
            teams.workspace(TEAM_A, [
              ["p-a1", at(10, 21)],
              ["p-a2", at(1, 9)],
            ]),
          ]);
          yield* pass.run;
          assert.notInclude(
            teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!,
            "held alpha work",
          );
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "keeps a published section after its project is unlinked and adds nothing new from it",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 12).getTime());
          yield* seedWorld;
          yield* say("t-a1", "first alpha one", at(10, 10));
          yield* say("t-a2", "first alpha two", at(10, 10));
          const teams = fakeTeams();
          teams.setWorkspaces([
            teams.workspace(TEAM_A, [
              ["p-a1", at(1, 9)],
              ["p-a2", at(1, 9)],
            ]),
          ]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          const device = yield* deviceIdOf(harness.baseDir);
          assert.include(teams.file(TEAM_A, dayOf(10), device)!, "first alpha two");

          // Alpha Two is unlinked; both projects keep working.
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          yield* say("t-a1", "later alpha one", at(10, 13));
          yield* say("t-a2", "later alpha two", at(10, 13));
          yield* TestClock.adjust(PARTIAL_INTERVAL_MS + 60_000);
          yield* pass.run;
          const text = teams.file(TEAM_A, dayOf(10), device)!;
          assert.include(text, "later alpha one");
          assert.include(text, "first alpha two");
          assert.notInclude(text, "later alpha two");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "rewrites old published days, beyond a year back, when a thread is no longer shared",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
          yield* seedWorld;
          yield* say("t-a1", "kept forever", at(10, 12));
          yield* say("t-a1-other", "regretted", at(10, 12));
          const teams = fakeTeams();
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          const device = yield* deviceIdOf(harness.baseDir);
          assert.include(teams.file(TEAM_A, dayOf(10), device)!, "regretted");

          yield* TestClock.adjust(500 * 24 * 60 * 60_000);
          yield* setSharing("t-a1-other", false);
          yield* pass.run;
          const text = teams.file(TEAM_A, dayOf(10), device)!;
          assert.include(text, "kept forever");
          assert.notInclude(text, "regretted");

          // When nothing is left, the file is removed.
          yield* setSharing("t-a1", false);
          yield* pass.run;
          assert.isNull(teams.file(TEAM_A, dayOf(10), device));
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("stops for a team whose access ended without removing its files, and forgets it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "team owned", at(10, 12));
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        const writes = teams.writes.length;

        teams.setWorkspaces([teams.workspace(TEAM_A, [], "lost")]);
        yield* setSharing("t-a1", false);
        yield* pass.run;
        assert.strictEqual(teams.writes.length, writes);
        assert.strictEqual(teams.teamFiles(TEAM_A).length, 1);
        // Access coming back starts from an empty record: nothing old is rewritten.
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        yield* pass.run;
        assert.strictEqual(teams.writes.length, writes);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "holds everything while access can't be checked, and never writes as another account",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
          yield* seedWorld;
          yield* say("t-a1", "alice work", at(10, 12));
          const teams = fakeTeams();
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          teams.state.account = { kind: "unavailable", message: "Campus sign-in is unreachable." };
          yield* pass.run;
          assert.strictEqual(teams.writes.length, 0);

          teams.state.account = {
            kind: "signed-in",
            author: ALICE,
            authorName: "Alice",
            workspaces: [teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])],
          };
          yield* pass.run;
          assert.strictEqual(teams.writes.length, 1);

          // Bob signs in here: Alice's record isn't reused, and Bob's own work is new to him.
          teams.state.account = {
            kind: "signed-in",
            author: BOB,
            authorName: "Bob",
            workspaces: [teams.workspace(TEAM_A, [["p-a1", at(10, 21)]])],
          };
          yield* setSharing("t-a1", false);
          yield* pass.run;
          assert.isTrue(teams.writes.every((write) => write.path.startsWith(`Daily/${ALICE}/`)));
          assert.isFalse(teams.writes.some((write) => write.text === null));
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("writes one file per device for the same author and day", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "shared work", at(10, 12));
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        for (const device of ["laptop", "desktop"]) {
          const pass = yield* makePass(path.join(harness.baseDir, device));
          yield* pass.attach(teams.source);
          yield* pass.run;
        }
        const paths = teams.teamFiles(TEAM_A).map(([key]) => key);
        assert.strictEqual(paths.length, 2);
        assert.notStrictEqual(paths[0], paths[1]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("holds new summaries while the model fails or Memory is off, and recovers", () =>
    Effect.gen(function* () {
      let failing = true;
      const harness = yield* makeHarness({ fail: () => failing });
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "eventually shared", at(10, 12));
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        assert.strictEqual(teams.writes.length, 0);
        assert.deepInclude(yield* pass.status(TEAM_A), { state: "held" });

        failing = false;
        yield* pass.run;
        assert.include(
          teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!,
          "eventually shared",
        );
        assert.deepInclude(yield* pass.status(TEAM_A), { state: "sharing" });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect(
    "abandons a write when a thread is chosen as Don't share during the account checks",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
          yield* seedWorld;
          yield* say("t-a1", "still shared", at(10, 12));
          yield* say("t-a1-other", "withdrawn during refresh", at(10, 12));
          const teams = fakeTeams();
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          let refreshes = 0;
          sqlHolder.current = yield* SqlClient.SqlClient;
          teams.state.beforeRequest = Effect.suspend(() =>
            refreshes++ === 0 ? withSql(setSharing("t-a1-other", false)) : Effect.void,
          );
          yield* pass.run;
          assert.isFalse(
            teams.writes.some((write) => write.text?.includes("withdrawn during refresh") === true),
          );
          const text = teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!;
          assert.include(text, "still shared");
          assert.notInclude(text, "withdrawn during refresh");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "while Memory is off, removes a thread chosen as Don't share and publishes no waiting text",
    () =>
      Effect.gen(function* () {
        const on = yield* makeHarness({});
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 12).getTime());
          yield* seedWorld;
          yield* say("t-a1", "published", at(10, 10));
          yield* say("t-a1-other", "withdrawn", at(10, 10));
          const pass = yield* makePass(on.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          const device = yield* deviceIdOf(on.baseDir);
          assert.include(teams.file(TEAM_A, dayOf(10), device)!, "withdrawn");

          // New work is summarized, but its upload waits.
          yield* say("t-a1", "waiting update", at(10, 11));
          yield* TestClock.adjust(PARTIAL_INTERVAL_MS + 60_000);
          teams.state.hold = { kind: "held", message: "Microsoft is offline." };
          yield* pass.run;
          teams.state.hold = null;

          // Memory is turned off over the same database and record, then a thread is withdrawn.
          const off = yield* makeTeamDailyPass({
            stateDir: on.baseDir,
            deviceLabel: "Test Mac",
            settings: yield* ServerSettings.ServerSettingsService.pipe(
              Effect.provide(ServerSettings.layerTest({ memoryEnabled: false })),
            ),
            textGeneration: yield* TextGeneration,
            maxCatchUpDays: MAX_CATCH_UP_DAYS,
            partialIntervalMs: PARTIAL_INTERVAL_MS,
            streamingGraceMs: STREAMING_GRACE_HOURS * 60 * 60_000,
          });
          yield* off.attach(teams.source);
          yield* setSharing("t-a1-other", false);
          yield* off.run;
          const text = teams.file(TEAM_A, dayOf(10), device)!;
          assert.notInclude(text, "withdrawn");
          assert.notInclude(text, "waiting update");
          assert.include(text, "published");
        }).pipe(Effect.provide(on.layer));
      }),
  );
  it.effect("marks each changed month, and publishes a marker left unpublished by an outage", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "october work", at(10, 12));
        yield* say("t-a1-other", "later withdrawn", at(10, 12));
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        const device = yield* deviceIdOf(harness.baseDir);
        const first = JSON.parse(teams.marker(TEAM_A, device)!) as {
          months: Record<string, string>;
        };
        assert.deepStrictEqual(Object.keys(first.months), ["2026-10"]);

        // Months later the old note is rewritten, but the marker's write fails after it.
        yield* TestClock.adjust(90 * 24 * 60 * 60_000);
        yield* setSharing("t-a1-other", false);
        teams.state.holdPaths = /\.changes\.json$/u;
        yield* pass.run;
        assert.notInclude(teams.file(TEAM_A, dayOf(10), device)!, "later withdrawn");
        assert.strictEqual(
          (JSON.parse(teams.marker(TEAM_A, device)!) as typeof first).months["2026-10"],
          first.months["2026-10"],
        );

        // The next pass has nothing else to write and still publishes the newer stamp.
        teams.state.holdPaths = null;
        yield* pass.run;
        const next = JSON.parse(teams.marker(TEAM_A, device)!) as typeof first;
        assert.isTrue(next.months["2026-10"]! > first.months["2026-10"]!);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
  for (const passWhileOff of [true, false])
    it.effect(
      `shares only work after Share this thread${passWhileOff ? "" : ", even when no pass saw it turned off"}`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({});
          yield* Effect.gen(function* () {
            yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
            yield* seedWorld;
            yield* say("t-a1", "shared at first", at(10, 10));
            const teams = fakeTeams();
            teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
            const pass = yield* makePass(harness.baseDir);
            yield* pass.attach(teams.source);
            yield* pass.run;
            const device = yield* deviceIdOf(harness.baseDir);
            assert.include(teams.file(TEAM_A, dayOf(10), device)!, "shared at first");

            yield* setSharing("t-a1", false);
            yield* say("t-a1", "written while off", at(10, 12));
            if (passWhileOff) {
              yield* TestClock.setTime(new Date(2026, 9, 10, 12, 30).getTime());
              yield* pass.run;
            }
            yield* reshare("t-a1", at(10, 13));
            yield* say("t-a1", "after sharing again", at(10, 14));
            yield* TestClock.setTime(new Date(2026, 9, 10, 16).getTime());
            yield* pass.run;
            const text = teams.file(TEAM_A, dayOf(10), device)!;
            assert.include(text, "after sharing again");
            assert.notInclude(text, "written while off");
            assert.notInclude(text, "shared at first");
          }).pipe(Effect.provide(harness.layer));
        }),
    );

  it.effect(
    "removes a day's section when its thread is turned off and on again with no new work",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
          yield* seedWorld;
          yield* say("t-a1", "withdrawn then shared again", at(10, 10));
          yield* say("t-a1-other", "kept", at(10, 10));
          const teams = fakeTeams();
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          // Off and on again before any pass; nothing new happens in the thread.
          yield* setSharing("t-a1", false);
          yield* reshare("t-a1", at(10, 12));
          yield* pass.run;
          const text = teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!;
          assert.include(text, "kept");
          assert.notInclude(text, "withdrawn then shared again");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  for (const after of ["Don't share", "unlink"] as const)
    it.effect(
      `settles a write whose answer was lost before ${after === "unlink" ? "an unlink" : "Don't share"}`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({});
          yield* Effect.gen(function* () {
            yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
            yield* seedWorld;
            yield* say("t-a1", "landed but unconfirmed", at(10, 12));
            const teams = fakeTeams();
            teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
            const pass = yield* makePass(harness.baseDir);
            yield* pass.attach(teams.source);
            // The upload lands, but its answer never arrives.
            teams.state.landThenLose = /\.md$/u;
            yield* pass.run;
            const device = yield* deviceIdOf(harness.baseDir);
            assert.include(teams.file(TEAM_A, dayOf(10), device)!, "landed but unconfirmed");
            teams.state.landThenLose = null;

            if (after === "unlink") {
              teams.setWorkspaces([teams.workspace(TEAM_A, [])]);
              yield* pass.run;
              // It was published, so it stays with the team.
              assert.include(teams.file(TEAM_A, dayOf(10), device)!, "landed but unconfirmed");
            } else {
              yield* setSharing("t-a1", false);
              yield* pass.run;
              // The file it may have created is found and removed.
              assert.isNull(teams.file(TEAM_A, dayOf(10), device));
            }
          }).pipe(Effect.provide(harness.layer));
        }),
    );

  it.effect(
    "never publishes a deleted thread's waiting text, and keeps what it already published",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          during: (input) =>
            input.threads.some((thread) => thread.activity.includes("deleted mid-model"))
              ? withSql(deleteThread("t-a2"))
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
          yield* seedWorld;
          yield* say("t-a1", "published first", at(10, 10));
          sqlHolder.current = yield* SqlClient.SqlClient;
          const teams = fakeTeams();
          teams.setWorkspaces([
            teams.workspace(TEAM_A, [
              ["p-a1", at(1, 9)],
              ["p-a2", at(1, 9)],
            ]),
          ]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          const device = yield* deviceIdOf(harness.baseDir);

          // Waiting text from a thread deleted before its upload never goes out.
          yield* say("t-a1-other", "waiting then deleted", at(10, 12));
          yield* say("t-a2", "deleted mid-model", at(10, 12));
          yield* TestClock.setTime(new Date(2026, 9, 10, 16).getTime());
          teams.state.hold = { kind: "held", message: "offline" };
          yield* pass.run;
          teams.state.hold = null;
          yield* deleteThread("t-a1-other");
          // The published thread is deleted too; what the team has stays.
          yield* deleteThread("t-a1");
          yield* pass.run;
          const text = teams.file(TEAM_A, dayOf(10), device)!;
          assert.include(text, "published first");
          assert.notInclude(text, "waiting then deleted");
          assert.notInclude(text, "deleted mid-model");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "leaves a day in the team's previous folder alone, and writes new days to the new one",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
          yield* seedWorld;
          yield* say("t-a1", "in the first folder", at(10, 12));
          const teams = fakeTeams();
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          const device = yield* deviceIdOf(harness.baseDir);

          teams.state.roots.set(TEAM_A, "root-2");
          yield* setSharing("t-a1", false);
          yield* setSharing("t-a1-other", true);
          yield* say("t-a1-other", "in the new folder", at(11, 12));
          yield* TestClock.setTime(new Date(2026, 9, 11, 20).getTime());
          yield* pass.run;
          // Nothing is removed from, or copied into, the wrong folder.
          assert.include(
            teams.file(TEAM_A, dayOf(10), device, ALICE, "root-1")!,
            "in the first folder",
          );
          assert.isNull(teams.file(TEAM_A, dayOf(10), device, ALICE, "root-2"));
          assert.include(
            teams.file(TEAM_A, dayOf(11), device, ALICE, "root-2")!,
            "in the new folder",
          );
          assert.isNotNull(teams.marker(TEAM_A, device, ALICE, "root-2"));
          assert.deepInclude(yield* pass.status(TEAM_A), { state: "held" });
          assert.include((yield* pass.status(TEAM_A))!.message!, "previous folder");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("keeps writing other days, withdrawals, and the marker when one day is refused", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "refused day", at(9, 12));
        yield* say("t-a1", "fine day", at(10, 12));
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        teams.state.rejectPaths = /2026-10-09 /u;
        yield* pass.run;
        const device = yield* deviceIdOf(harness.baseDir);
        assert.isNull(teams.file(TEAM_A, dayOf(9), device));
        assert.include(teams.file(TEAM_A, dayOf(10), device)!, "fine day");
        assert.isNotNull(teams.marker(TEAM_A, device));
        assert.deepInclude(yield* pass.status(TEAM_A), { state: "held" });
      }).pipe(Effect.provide(harness.layer));
    }),
  );
  for (const before of ["Don't share", "Don't share then Share"] as const)
    it.effect(`withdraws a published thread deleted after ${before}, before any pass`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
          yield* seedWorld;
          yield* say("t-a1", "withdrawn and deleted", at(10, 10));
          yield* say("t-a1-other", "kept", at(10, 10));
          const teams = fakeTeams();
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          yield* setSharing("t-a1", false);
          if (before === "Don't share then Share") yield* reshare("t-a1", at(10, 12));
          yield* deleteThread("t-a1");
          yield* pass.run;
          const text = teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!;
          assert.include(text, "kept");
          assert.notInclude(text, "withdrawn and deleted");
        }).pipe(Effect.provide(harness.layer));
      }),
    );

  it.effect("finishes a withdrawal when the thread is deleted while the removal waits", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
        yield* seedWorld;
        yield* say("t-a1", "withdrawn", at(10, 10));
        yield* say("t-a1-other", "kept", at(10, 10));
        sqlHolder.current = yield* SqlClient.SqlClient;
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        yield* setSharing("t-a1", false);
        let once = true;
        teams.state.beforeRequest = Effect.suspend(() => {
          if (!once) return Effect.void;
          once = false;
          return withSql(deleteThread("t-a1"));
        });
        yield* pass.run;
        const text = teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!;
        assert.include(text, "kept");
        assert.notInclude(text, "withdrawn");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  for (const when of ["before", "after"] as const)
    it.effect(
      `keeps an unconfirmed first write in its folder when the folder changes ${when} it is checked`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({});
          yield* Effect.gen(function* () {
            yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
            yield* seedWorld;
            yield* say("t-a1", "landed in the first folder", at(10, 12));
            const teams = fakeTeams();
            teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
            const pass = yield* makePass(harness.baseDir);
            yield* pass.attach(teams.source);
            teams.state.landThenLose = /\.md$/u;
            yield* pass.run;
            teams.state.landThenLose = null;
            const device = yield* deviceIdOf(harness.baseDir);
            if (when === "after") yield* pass.run;
            teams.state.roots.set(TEAM_A, "root-2");
            yield* setSharing("t-a1", false);
            yield* pass.run;
            // The first folder's file isn't forgotten, and the new folder isn't touched.
            assert.include(
              teams.file(TEAM_A, dayOf(10), device, ALICE, "root-1")!,
              "landed in the first folder",
            );
            assert.isNull(teams.file(TEAM_A, dayOf(10), device, ALICE, "root-2"));
            assert.include((yield* pass.status(TEAM_A))!.message!, "previous folder");
            // The obligation is still there if the first folder comes back.
            teams.state.roots.set(TEAM_A, "root-1");
            yield* pass.run;
            assert.isNull(teams.file(TEAM_A, dayOf(10), device, ALICE, "root-1"));
          }).pipe(Effect.provide(harness.layer));
        }),
    );

  for (const then of ["unlink", "Don't share"] as const)
    it.effect(`holds an unconfirmed write that was edited in SharePoint, then ${then}`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
          yield* seedWorld;
          yield* say("t-a1", "confirmed earlier", at(10, 10));
          const teams = fakeTeams();
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          const device = yield* deviceIdOf(harness.baseDir);
          // New text lands but its answer is lost, then a teammate edits the file.
          yield* say("t-a1-other", "landed unconfirmed", at(10, 12));
          yield* TestClock.setTime(new Date(2026, 9, 10, 16).getTime());
          teams.state.landThenLose = /\.md$/u;
          yield* pass.run;
          teams.state.landThenLose = null;
          const sent = teams.file(TEAM_A, dayOf(10), device)!;
          assert.include(sent, "landed unconfirmed");
          const edited = `${sent}\nA teammate's note.`;
          teams.editRemote(TEAM_A, dayOf(10), device, edited);
          if (then === "unlink") teams.setWorkspaces([teams.workspace(TEAM_A, [])]);
          else yield* setSharing("t-a1", false);
          const writes = teams.allWrites.length;
          yield* pass.run;
          // Nothing is assumed: the edited file is left as it is, and the day says why.
          assert.strictEqual(teams.file(TEAM_A, dayOf(10), device), edited);
          assert.isFalse(teams.allWrites.slice(writes).some((write) => write.path.endsWith(".md")));
          const message = (yield* pass.status(TEAM_A))!.message!;
          assert.include(message, "changed in SharePoint");
          if (then === "Don't share") assert.include(message, "chose not to share");

          // Once the file matches what Harness sent, the day resolves and the choice applies.
          teams.editRemote(TEAM_A, dayOf(10), device, sent);
          yield* pass.run;
          const text = teams.file(TEAM_A, dayOf(10), device);
          if (then === "unlink") {
            // Both sections were published, so they stay with the team.
            assert.include(text!, "confirmed earlier");
            assert.include(text!, "landed unconfirmed");
          } else {
            assert.include(text!, "landed unconfirmed");
            assert.notInclude(text!, "confirmed earlier");
          }
        }).pipe(Effect.provide(harness.layer));
      }),
    );
  for (const answer of ["held", "landed"] as const)
    it.effect(
      `never keeps withdrawn text as the baseline of a thread shared again (${answer} upload)`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({});
          yield* Effect.gen(function* () {
            yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
            yield* seedWorld;
            yield* say("t-a1", "first generation", at(10, 10));
            const teams = fakeTeams();
            teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
            const pass = yield* makePass(harness.baseDir);
            yield* pass.attach(teams.source);
            if (answer === "landed") teams.state.landThenLose = /\.md$/u;
            yield* pass.run;
            teams.state.landThenLose = null;
            const device = yield* deviceIdOf(harness.baseDir);
            assert.include(teams.file(TEAM_A, dayOf(10), device)!, "first generation");

            // Don't share, then Share again before any pass, then new work; the upload waits.
            yield* setSharing("t-a1", false);
            yield* reshare("t-a1", at(10, 12));
            yield* say("t-a1", "second generation", at(10, 13));
            yield* TestClock.setTime(new Date(2026, 9, 10, 16).getTime());
            teams.state.hold = { kind: "held", message: "offline" };
            yield* pass.run;
            teams.state.hold = null;
            // The record holds no published baseline for the new generation, so under size
            // pressure nothing withdrawn could be put back.
            const section = yield* sectionOf(harness.baseDir, TEAM_A, dayOf(10), "t-a1");
            assert.isNotNull(section);
            assert.isNull(section!.publishedText);
            // Its removal is still owed, whether it was confirmed or learned to have landed.
            assert.isTrue(section!.owesRemoval);

            yield* pass.run;
            const text = teams.file(TEAM_A, dayOf(10), device)!;
            assert.include(text, "second generation");
            assert.notInclude(text, "first generation");
            assert.isUndefined(
              (yield* sectionOf(harness.baseDir, TEAM_A, dayOf(10), "t-a1"))!.owesRemoval,
            );
          }).pipe(Effect.provide(harness.layer));
        }),
    );

  for (const where of ["edited in SharePoint", "in the team's previous folder"] as const)
    it.effect(`keeps a re-shared thread's withdrawn text owed while its day is ${where}`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({});
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
          yield* seedWorld;
          yield* say("t-a1", "first generation", at(10, 10));
          const teams = fakeTeams();
          teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
          const pass = yield* makePass(harness.baseDir);
          yield* pass.attach(teams.source);
          yield* pass.run;
          const device = yield* deviceIdOf(harness.baseDir);
          const published = teams.file(TEAM_A, dayOf(10), device)!;
          assert.include(published, "first generation");

          // Don't share, then Share again before any pass, then new work.
          yield* setSharing("t-a1", false);
          yield* reshare("t-a1", at(10, 12));
          yield* say("t-a1", "second generation", at(10, 13));
          yield* TestClock.setTime(new Date(2026, 9, 10, 16).getTime());
          const edited = `${published}\nA teammate's note.`;
          if (where === "edited in SharePoint") {
            // A teammate edits the file, so the replacement is refused and kept unconfirmed.
            teams.editRemote(TEAM_A, dayOf(10), device, edited);
            // The change marker is refused too, which mustn't hide what the day says.
            teams.state.hold = { kind: "changed", message: "The file was changed in SharePoint." };
            yield* pass.run;
            teams.state.hold = null;
            // Said from the first refused write on.
            assert.include((yield* pass.status(TEAM_A))!.message!, "chose not to share");
          } else {
            // The team's folder changes, so the day stays in the original folder.
            teams.state.roots.set(TEAM_A, "root-2");
            yield* pass.run;
          }
          const section = yield* sectionOf(harness.baseDir, TEAM_A, dayOf(10), "t-a1");
          assert.isNull(section!.publishedText);
          assert.isTrue(section!.owesRemoval);

          // Every check while the day can't be changed still says the withdrawn text may be there.
          for (let check = 0; check < 2; check++) {
            yield* pass.run;
            const message = (yield* pass.status(TEAM_A))!.message!;
            assert.include(
              message,
              where === "edited in SharePoint" ? "changed in SharePoint" : "previous folder",
            );
            assert.include(message, "chose not to share");
            assert.strictEqual(
              teams.file(TEAM_A, dayOf(10), device, ALICE, "root-1"),
              where === "edited in SharePoint" ? edited : published,
            );
          }

          // Once the file can be replaced, the new generation replaces the old one for good.
          if (where === "edited in SharePoint")
            teams.editRemote(TEAM_A, dayOf(10), device, published);
          else teams.state.roots.set(TEAM_A, "root-1");
          yield* pass.run;
          const text = teams.file(TEAM_A, dayOf(10), device, ALICE, "root-1")!;
          assert.include(text, "second generation");
          assert.notInclude(text, "first generation");
          assert.isUndefined(
            (yield* sectionOf(harness.baseDir, TEAM_A, dayOf(10), "t-a1"))!.owesRemoval,
          );
          assert.notInclude((yield* pass.status(TEAM_A))?.message ?? "", "chose not to share");
        }).pipe(Effect.provide(harness.layer));
      }),
    );

  for (const where of ["edited in SharePoint", "in the team's previous folder"] as const)
    it.effect(
      `keeps an unconfirmed upload's withdrawn generation owed while its day is ${where}`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({});
          yield* Effect.gen(function* () {
            yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
            yield* seedWorld;
            yield* say("t-a1", "first generation", at(10, 10));
            const teams = fakeTeams();
            teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
            const pass = yield* makePass(harness.baseDir);
            yield* pass.attach(teams.source);
            // The first upload lands, but its answer is lost: nothing is confirmed published.
            teams.state.landThenLose = /\.md$/u;
            yield* pass.run;
            teams.state.landThenLose = null;
            const device = yield* deviceIdOf(harness.baseDir);
            const sent = teams.file(TEAM_A, dayOf(10), device)!;
            assert.include(sent, "first generation");
            assert.isNull(
              (yield* sectionOf(harness.baseDir, TEAM_A, dayOf(10), "t-a1"))!.publishedText,
            );

            // Don't share, then Share again before any pass, then new work.
            yield* setSharing("t-a1", false);
            yield* reshare("t-a1", at(10, 12));
            yield* say("t-a1", "second generation", at(10, 13));
            yield* TestClock.setTime(new Date(2026, 9, 10, 16).getTime());
            const edited = `${sent}\nA teammate's note.`;
            if (where === "edited in SharePoint")
              teams.editRemote(TEAM_A, dayOf(10), device, edited);
            else teams.state.roots.set(TEAM_A, "root-2");

            // Every check before the upload's outcome is known says the withdrawn text may be there.
            for (let check = 0; check < 2; check++) {
              yield* pass.run;
              const message = (yield* pass.status(TEAM_A))!.message!;
              assert.include(
                message,
                where === "edited in SharePoint" ? "changed in SharePoint" : "previous folder",
              );
              assert.include(message, "chose not to share");
              assert.strictEqual(
                teams.file(TEAM_A, dayOf(10), device, ALICE, "root-1"),
                where === "edited in SharePoint" ? edited : sent,
              );
              assert.isTrue(
                (yield* sectionOf(harness.baseDir, TEAM_A, dayOf(10), "t-a1"))!.owesRemoval,
              );
            }

            // Once the outcome is known and the file can be replaced, the old generation leaves.
            if (where === "edited in SharePoint") teams.editRemote(TEAM_A, dayOf(10), device, sent);
            else teams.state.roots.set(TEAM_A, "root-1");
            yield* pass.run;
            const text = teams.file(TEAM_A, dayOf(10), device, ALICE, "root-1")!;
            assert.include(text, "second generation");
            assert.notInclude(text, "first generation");
            assert.isUndefined(
              (yield* sectionOf(harness.baseDir, TEAM_A, dayOf(10), "t-a1"))!.owesRemoval,
            );
            assert.notInclude((yield* pass.status(TEAM_A))?.message ?? "", "chose not to share");
          }).pipe(Effect.provide(harness.layer));
        }),
    );

  for (const choice of ["Don't share", "Don't share then Share"] as const)
    it.effect(
      `says a lost upload may hold a thread after ${choice} while the file can't be read`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({});
          yield* Effect.gen(function* () {
            yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
            yield* seedWorld;
            yield* say("t-a1", "first generation", at(10, 10));
            yield* say("t-a1-other", "kept", at(10, 10));
            const teams = fakeTeams();
            teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
            const pass = yield* makePass(harness.baseDir);
            yield* pass.attach(teams.source);
            teams.state.landThenLose = /\.md$/u;
            yield* pass.run;
            teams.state.landThenLose = null;
            const device = yield* deviceIdOf(harness.baseDir);

            yield* setSharing("t-a1", false);
            if (choice === "Don't share then Share") {
              yield* reshare("t-a1", at(10, 12));
              yield* say("t-a1", "second generation", at(10, 13));
            }
            yield* TestClock.setTime(new Date(2026, 9, 10, 16).getTime());
            teams.state.inspectHeld = true;
            for (let check = 0; check < 2; check++) {
              yield* pass.run;
              const message = (yield* pass.status(TEAM_A))!.message!;
              assert.include(message, "couldn't confirm");
              assert.include(message, "chose not to share");
            }
            teams.state.inspectHeld = false;
            yield* pass.run;
            const text = teams.file(TEAM_A, dayOf(10), device)!;
            assert.include(text, "kept");
            assert.notInclude(text, "first generation");
            assert.notInclude((yield* pass.status(TEAM_A))?.message ?? "", "chose not to share");
          }).pipe(Effect.provide(harness.layer));
        }),
    );

  it.effect("says a withdrawn thread is still in the team's file while its removal waits", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 11).getTime());
        yield* seedWorld;
        yield* say("t-a1", "withdrawn", at(10, 10));
        yield* say("t-a1-other", "kept", at(10, 10));
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        const device = yield* deviceIdOf(harness.baseDir);
        yield* setSharing("t-a1", false);
        for (const [paths, expected] of [
          ["holdPaths", "offline"],
          ["rejectPaths", "Too large"],
        ] as const) {
          teams.state[paths] = /\.md$/u;
          for (let check = 0; check < 2; check++) {
            yield* pass.run;
            const message = (yield* pass.status(TEAM_A))!.message!;
            assert.include(message, expected);
            assert.include(message, "chose not to share");
            assert.include(teams.file(TEAM_A, dayOf(10), device)!, "withdrawn");
          }
          teams.state[paths] = null;
        }
        yield* pass.run;
        assert.notInclude(teams.file(TEAM_A, dayOf(10), device)!, "withdrawn");
        assert.notInclude((yield* pass.status(TEAM_A))?.message ?? "", "chose not to share");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("says a withdrawn thread may remain on a full day whose new work is waiting", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 12).getTime());
        yield* seedWorld;
        yield* say("t-a1", "first generation", at(10, 10));
        // More work than one day's file holds, so some of it always waits.
        for (let index = 0; index < 60; index++) {
          const threadId = `t-fill-${String(index).padStart(2, "0")}`;
          yield* seedThread(threadId, "p-a1", `Filler ${index}`);
          yield* say(threadId, `${threadId} ${"x".repeat(1_000)}`, at(10, 11));
        }
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        const device = yield* deviceIdOf(harness.baseDir);
        const published = teams.file(TEAM_A, dayOf(10), device)!;
        assert.include(published, "first generation");
        assert.include((yield* pass.status(TEAM_A))!.message!, "size limit");

        yield* setSharing("t-a1", false);
        yield* reshare("t-a1", at(10, 13));
        yield* say("t-a1", "second generation", at(10, 14));
        yield* TestClock.setTime(new Date(2026, 9, 10, 16).getTime());
        teams.editRemote(TEAM_A, dayOf(10), device, `${published}\nA teammate's note.`);
        teams.state.hold = { kind: "changed", message: "The file was changed in SharePoint." };
        yield* pass.run;
        // The day's first problem is the size limit; it still says what the team may have.
        const message = (yield* pass.status(TEAM_A))!.message!;
        assert.include(message, "size limit");
        assert.include(message, "chose not to share");

        // Once the withdrawal is confirmed, work still waiting for room says only that.
        teams.state.hold = null;
        teams.editRemote(TEAM_A, dayOf(10), device, published);
        yield* pass.run;
        assert.notInclude(teams.file(TEAM_A, dayOf(10), device)!, "first generation");
        const after = (yield* pass.status(TEAM_A))!.message!;
        assert.include(after, "size limit");
        assert.notInclude(after, "chose not to share");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("isn't held back by a turn still being written that the team would never see", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "eligible work", at(10, 12));
        // Turns still streaming in work the team never reads: an opted-out thread, a deleted
        // thread, a personal project, before the link began, and before Share this thread.
        yield* streaming("t-a2", at(10, 19));
        yield* setSharing("t-a2", false);
        yield* streaming("t-b", at(10, 19));
        yield* deleteThread("t-b");
        yield* streaming("t-personal", at(10, 19));
        yield* streaming("t-a1-other", at(10, 8));
        yield* reshare("t-a1-other", at(10, 18));
        yield* streaming("t-a1-other", at(10, 17));
        const teams = fakeTeams();
        teams.setWorkspaces([
          teams.workspace(TEAM_A, [
            ["p-a1", at(10, 9)],
            ["p-a2", at(1, 9)],
            ["p-b", at(1, 9)],
          ]),
        ]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        assert.include(
          teams.file(TEAM_A, dayOf(10), yield* deviceIdOf(harness.baseDir))!,
          "eligible work",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("waits for a turn still being written that the team would see", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      yield* Effect.gen(function* () {
        yield* TestClock.setTime(new Date(2026, 9, 10, 20).getTime());
        yield* seedWorld;
        yield* say("t-a1", "eligible work", at(10, 12));
        yield* streaming("t-a1", at(10, 19));
        const teams = fakeTeams();
        teams.setWorkspaces([teams.workspace(TEAM_A, [["p-a1", at(1, 9)]])]);
        const pass = yield* makePass(harness.baseDir);
        yield* pass.attach(teams.source);
        yield* pass.run;
        assert.strictEqual(teams.writes.length, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
