import { seedV2Activity } from "../persistence/HarnessActivity.testkit.ts";
// @effect-diagnostics globalDate:off - fixtures are fixed instants.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ExecutionEnvironmentDescriptor,
  IdeaAction,
  IdeaSource,
  type IdeasSnapshot,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import {
  type GeneratedIdea,
  type IdeasGenerationInput,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import * as Ideas from "./Ideas.ts";
import { FEATURE_IDEAS } from "./featureIdeas.ts";
import { availableStarters } from "./starterIdeas.ts";

// Tests run without plugins, so only the general starter ideas are offered.
const GENERAL_STARTERS = availableStarters(new Set());

const NOW = Date.parse("2026-10-13T16:00:00.000Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const encodeIdeaContent = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      icon: Schema.String,
      title: Schema.String,
      body: Schema.String,
      sources: Schema.Array(IdeaSource),
      action: IdeaAction,
    }),
  ),
);

const threadIdea = (overrides: Partial<GeneratedIdea> = {}): GeneratedIdea => ({
  ref: "thread:thread-1",
  topic: "finish reconciliation",
  sources: ["thread:thread-1"],
  icon: "🧾",
  title: "I can finish the Q1 travel reconciliation",
  body: "You stopped with 41 of 58 lines matched. I can match the rest and list what's left.",
  action: "resume-thread",
  projectId: "",
  prompt: "Please match the remaining travel lines and list the ones you could not match.",
  ...overrides,
});

const seedWork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const created = iso(NOW - 3 * DAY);
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project-1', 'Budget Office', '/nonexistent/budget', '[]', ${created}, ${created})
  `;
  yield* sql`
    INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES ('thread-1', 'project-1', 'Q1 travel reconciliation', ${created}, ${iso(NOW - DAY)})
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('m1', 'thread-1', 'user', 'Match the travel lines.', 0, ${iso(NOW - DAY)}, ${iso(NOW - DAY)})
  `;
});

const makeHarness = (
  generate: (
    input: IdeasGenerationInput,
  ) => Effect.Effect<ReadonlyArray<GeneratedIdea>, TextGenerationError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ideas-test-" });
    const calls: IdeasGenerationInput[] = [];
    const events: Array<{ readonly event: string; readonly properties: unknown }> = [];
    const layer = Layer.mergeAll(
      Layer.mock(AnalyticsService)({
        record: (event, properties) => Effect.sync(() => events.push({ event, properties })),
        flush: Effect.void,
      }),
      ServerSettings.layerTest({ memoryEnabled: false }),
      Layer.mock(ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: "env-1",
          label: "Test Mac",
          platform: { os: "darwin", arch: "arm64" },
        } as unknown as ExecutionEnvironmentDescriptor),
      }),
      Layer.mock(TextGeneration)({
        generateIdeas: (input) =>
          Effect.sync(() => calls.push(input)).pipe(
            Effect.andThen(generate(input)),
            Effect.map((ideas) => ({ ideas })),
          ),
      }),
    ).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    );
    return { calls, events, layer };
  });

const titles = (snapshot: IdeasSnapshot) => snapshot.ideas.map((idea) => idea.title);

it.layer(NodeServices.layer)("Ideas", (it) => {
  it.effect("uses V2-only threads and authoritative imported messages in generation", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness(() =>
        Effect.succeed([threadIdea({ ref: "thread:thread-v2", sources: ["thread:thread-v2"] })]),
      );
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        yield* seedV2Activity({
          threadId: "thread-1",
          projectId: "project-1",
          title: "Upgraded budget task",
          at: iso(NOW - DAY),
          messages: [{ id: "m1", role: "user", text: "Authoritative V2 budget request" }],
        });
        yield* seedV2Activity({
          threadId: "thread-v2",
          projectId: "project-1",
          title: "V2-only task",
          at: iso(NOW - DAY),
          messages: [
            { id: "v2-only", role: "user", text: "V2-only work" },
            { id: "v2-stream", role: "assistant", text: "Unfinished V2 idea", streaming: true },
          ],
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES ('deleted-v2', 'project-1', 'Deleted legacy idea source', ${iso(NOW - DAY)}, ${iso(NOW - DAY)})`;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('deleted-source', 'deleted-v2', 'user', 'Deleted V2 idea source', 0, ${iso(NOW - DAY)}, ${iso(NOW - DAY)})`;
        yield* seedV2Activity({
          threadId: "deleted-v2",
          projectId: "project-1",
          title: "V2 tombstone",
          at: iso(NOW - DAY),
          deletedAt: iso(NOW),
          messages: [],
        });
        const ideas = yield* Ideas.make;
        yield* ideas.markViewed;
        yield* ideas.awaitIdle;
        const context = calls[0]?.context ?? "";
        assert.include(context, "Authoritative V2 budget request");
        assert.notInclude(context, "Match the travel lines.");
        assert.include(context, "thread:thread-v2");
        assert.notInclude(context, "Unfinished V2 idea");
        assert.notInclude(context, "Deleted V2 idea source");
        assert.notInclude(context, "thread:deleted-v2");
        const snapshot = yield* ideas.list;
        assert.isTrue(
          snapshot.ideas.some(
            (idea) => idea.action.kind === "resume-thread" && idea.action.threadId === "thread-v2",
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("keeps only generated ideas that cite real threads, and clears unseen on view", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness(() =>
        Effect.succeed([
          threadIdea(),
          threadIdea({ ref: "thread:invented", title: "I can finish a thread that never existed" }),
        ]),
      );
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        const ideas = yield* Ideas.make;
        const viewed = yield* ideas.markViewed;
        assert.strictEqual(viewed.state, "generating");
        yield* ideas.awaitIdle;

        const snapshot = yield* ideas.list;
        assert.strictEqual(calls.length, 1);
        assert.include(calls[0]?.context ?? "", "thread:thread-1");
        const resumed = snapshot.ideas.find((idea) => idea.section === "continue");
        assert.deepStrictEqual(resumed?.action, {
          kind: "resume-thread",
          threadId: "thread-1",
          prompt: "Please match the remaining travel lines and list the ones you could not match.",
        } as never);
        assert.deepStrictEqual(resumed?.sources, [
          { kind: "thread", label: "Thread · Q1 travel reconciliation" },
        ]);
        assert.notInclude(titles(snapshot), "I can finish a thread that never existed");
        assert.strictEqual(viewed.unseenCount, 0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("finishes a requested run after the request that started it has returned", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Like Codex, the model writes a temporary file removed with the scope it runs in.
      const { layer } = yield* makeHarness(() =>
        Effect.gen(function* () {
          const scope = yield* Effect.serviceOption(Scope.Scope);
          if (Option.isNone(scope)) return yield* Effect.die("no scope");
          const file = yield* fs
            .makeTempFileScoped({ prefix: "t3-ideas-model-" })
            .pipe(Effect.provideService(Scope.Scope, scope.value));
          yield* fs.writeFileString(file, "{}");
          return [threadIdea()];
        }).pipe(Effect.orDie),
      );
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        const ideas = yield* Ideas.make;
        // The request's scope closes as soon as it returns, as an RPC's does.
        yield* ideas.suggestMore.pipe(Effect.scoped);
        yield* ideas.awaitIdle;
        const snapshot = yield* ideas.list;
        assert.include(titles(snapshot), "I can finish the Q1 travel reconciliation");
        assert.isNull(snapshot.message);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect(
    "blocks reworded rejected and used ideas beyond the title window and recent-title limit",
    () =>
      Effect.gen(function* () {
        const rejectedTitle = "Diagram the team's onboarding process";
        const sentTitle = "Summarize the department's purchasing workflow";
        const { layer } = yield* makeHarness(() =>
          Effect.succeed([
            threadIdea({ title: rejectedTitle, topic: "map onboarding" }),
            threadIdea({ title: sentTitle, topic: "describe purchasing" }),
          ]),
        );
        yield* TestClock.setTime(NOW);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedWork;
          for (const [index, status, title] of [
            [0, "rejected", rejectedTitle],
            [1, "sent", sentTitle],
          ] as const) {
            const old = iso(NOW - 61 * DAY);
            const content = yield* encodeIdeaContent({
              icon: "💡",
              title,
              body: "An earlier suggestion.",
              sources: [],
              action: { kind: "new-thread", projectId: null, prompt: "Help with this task." },
            });
            yield* sql`
            INSERT INTO ideas (idea_id, idea_key, section, content_json, status, created_at, updated_at, hidden_at)
            VALUES (${`old-${index}`}, ${`plugin:tool#old-topic-${index}`}, 'tools', ${content}, ${status}, ${old}, ${old}, ${old})
          `;
          }
          // Recent history must not displace permanent feedback from repeat validation.
          for (let index = 0; index < 60; index++) {
            const content = yield* encodeIdeaContent({
              icon: "💡",
              title: `Recent unrelated idea ${index}`,
              body: "A different suggestion.",
              sources: [],
              action: { kind: "new-thread", projectId: null, prompt: "Help with another task." },
            });
            yield* sql`
            INSERT INTO ideas (idea_id, idea_key, section, content_json, status, created_at, updated_at, hidden_at)
            VALUES (${`recent-${index}`}, ${`plugin:other#topic-${index}`}, 'tools', ${content}, 'rejected', ${iso(NOW)}, ${iso(NOW)}, ${iso(NOW)})
          `;
          }
          const ideas = yield* Ideas.make;
          yield* ideas.suggestMore;
          yield* ideas.awaitIdle;
          const snapshot = yield* ideas.list;
          assert.notInclude(titles(snapshot), rejectedTitle);
          assert.notInclude(titles(snapshot), sentTitle);
          assert.isNull(snapshot.message);
          assert.isAbove(snapshot.ideas.length, 0);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.effect("keeps an opened idea until its draft is sent, then never suggests it again", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([threadIdea()]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedWork;
        const ideas = yield* Ideas.make;
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const idea = (yield* ideas.list).ideas.find((entry) => entry.section === "continue");
        assert.isDefined(idea);

        const opened = yield* ideas.feedback({ ideaId: idea!.id, kind: "opened" });
        assert.isNotNull(opened.ideas.find((entry) => entry.id === idea!.id)?.openedAt);

        yield* TestClock.adjust(HOUR);
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m2', 'thread-1', 'user', 'Please match the remaining travel lines.', 0, ${iso(NOW + HOUR)}, ${iso(NOW + HOUR)})
        `;
        const afterSend = yield* ideas.list;
        assert.isUndefined(afterSend.ideas.find((entry) => entry.id === idea!.id));

        yield* TestClock.adjust(20 * DAY);
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        assert.notInclude(titles(yield* ideas.list), "I can finish the Q1 travel reconciliation");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect(
    "retires cards from before the update that leave a blank or are no longer offered",
    () =>
      Effect.gen(function* () {
        const { layer } = yield* makeHarness(() => Effect.succeed([]));
        yield* TestClock.setTime(NOW);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = [
            [
              "old-template",
              "starter:meeting-follow-up",
              "starter",
              "Turn these notes into an email: [paste your notes here]",
            ],
            [
              "old-adapted",
              "starter:decision-memo",
              "starter",
              "Write a one-page memo on the course filter.",
            ],
            [
              "blank-tool",
              "plugin:microsoft-365#draft-reply",
              "tools",
              "Search my mail for [topic or sender] and draft a reply.",
            ],
            [
              "complete-tool",
              "plugin:microsoft-365#digest",
              "tools",
              "Summarize my last three days of email.",
            ],
          ] as const;
          for (const [id, key, section, prompt] of rows) {
            const content = yield* encodeIdeaContent({
              icon: "💡",
              title: `Idea ${id}`,
              body: "An earlier suggestion.",
              sources: [],
              action: { kind: "new-thread", projectId: null, prompt },
            });
            yield* sql`
            INSERT INTO ideas (idea_id, idea_key, section, content_json, status, created_at, updated_at)
            VALUES (${id}, ${key}, ${section}, ${content}, 'active', ${iso(NOW)}, ${iso(NOW)})
          `;
          }
          const ideas = yield* Ideas.make;
          // The retired starters are replaced once with ready-made ones.
          const upgraded = yield* ideas.list;
          assert.deepStrictEqual(
            titles(upgraded).toSorted(),
            [
              "Idea complete-tool",
              ...GENERAL_STARTERS.slice(0, 5).map((starter) => starter.title),
            ].toSorted(),
          );
          for (const idea of upgraded.ideas.filter((entry) => entry.section === "starter")) {
            yield* ideas.feedback({ ideaId: idea.id, kind: "dismissed" });
          }
          assert.deepStrictEqual(titles(yield* ideas.list), ["Idea complete-tool"]);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.effect("shows a saved starter card with the library's current title", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const starter = GENERAL_STARTERS[0]!;
        const content = yield* encodeIdeaContent({
          icon: starter.icon,
          title: "I can do the old wording",
          body: starter.body,
          sources: [],
          action: { kind: "new-thread", projectId: null, prompt: starter.prompt },
        });
        yield* sql`
          INSERT INTO ideas (idea_id, idea_key, section, content_json, status, created_at, updated_at)
          VALUES ('saved-starter', ${`starter:${starter.id}`}, 'starter', ${content}, 'active', ${iso(NOW)}, ${iso(NOW)})
        `;
        const ideas = yield* Ideas.make;
        const saved = (yield* ideas.list).ideas.find((idea) => idea.id === "saved-starter");
        assert.strictEqual(saved?.title, starter.title);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("never brings back an idea whose draft was sent after its card was dismissed", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ideas = yield* Ideas.make;
        const idea = (yield* ideas.list).ideas.find(
          (entry) => entry.title === GENERAL_STARTERS[0]!.title,
        );
        assert.isDefined(idea);
        yield* ideas.feedback({
          ideaId: idea!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("draft-thread-3"),
        });
        yield* ideas.feedback({ ideaId: idea!.id, kind: "dismissed" });
        yield* TestClock.adjust(HOUR);
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-late', 'draft-thread-3', 'user', 'Here are my notes.', 0, ${iso(NOW + HOUR)}, ${iso(NOW + HOUR)})
        `;
        yield* TestClock.adjust(15 * DAY);
        // Past every unshown starter, so only the recorded send can keep this one away.
        for (let round = 0; round < 3; round++) {
          yield* ideas.suggestMore;
          yield* ideas.awaitIdle;
        }
        assert.notInclude(titles(yield* ideas.list), GENERAL_STARTERS[0]!.title);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("still counts a sent draft as used when its card is opened again", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ideas = yield* Ideas.make;
        const [idea] = (yield* ideas.list).ideas;
        yield* ideas.feedback({
          ideaId: idea!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("draft-thread-4"),
        });
        yield* TestClock.adjust(HOUR);
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-first', 'draft-thread-4', 'user', 'Sent from the first draft.', 0, ${iso(NOW + HOUR)}, ${iso(NOW + HOUR)})
        `;
        yield* TestClock.adjust(HOUR);
        // A card still on screen from before the send is opened again into a new draft.
        const reopened = yield* ideas.feedback({
          ideaId: idea!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("draft-thread-5"),
        });
        assert.isUndefined(reopened.ideas.find((entry) => entry.id === idea!.id));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("records each client's draft once, however often it is opened", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const [idea] = (yield* ideas.list).ideas;
        yield* Effect.forEach(
          ["desktop-draft", "browser-draft", "desktop-draft"],
          (draft) =>
            ideas.feedback({
              ideaId: idea!.id,
              kind: "opened",
              draftThreadId: ThreadId.make(draft),
            }),
          { concurrency: "unbounded" },
        );
        const recorded = (yield* ideas.list).ideas.find((entry) => entry.id === idea!.id);
        assert.sameMembers(
          [...(recorded?.draftThreadIds ?? [])],
          ["desktop-draft", "browser-draft"],
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("keeps Not relevant permanent when a background run retired the card first", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ideas = yield* Ideas.make;
        const idea = (yield* ideas.list).ideas.find(
          (entry) => entry.title === GENERAL_STARTERS[0]!.title,
        );
        assert.isDefined(idea);
        // A background batch retires the card while it is still on the user's screen.
        yield* sql`
          UPDATE ideas SET status = 'expired', hidden_at = ${iso(NOW)}, updated_at = ${iso(NOW)}
          WHERE idea_id = ${idea!.id}
        `;
        yield* ideas.feedback({ ideaId: idea!.id, kind: "rejected" });
        yield* TestClock.adjust(20 * DAY);
        for (let round = 0; round < 3; round++) {
          yield* ideas.suggestMore;
          yield* ideas.awaitIdle;
        }
        assert.notInclude(titles(yield* ideas.list), GENERAL_STARTERS[0]!.title);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("counts a send from a client whose clock is behind the server", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([threadIdea()]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedWork;
        const ideas = yield* Ideas.make;
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const snapshot = yield* ideas.list;
        const starter = snapshot.ideas.find((entry) => entry.section === "starter");
        const resume = snapshot.ideas.find((entry) => entry.section === "continue");
        assert.isDefined(starter);
        assert.isDefined(resume);
        yield* ideas.feedback({
          ideaId: starter!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("skewed-draft"),
        });
        yield* ideas.feedback({ ideaId: resume!.id, kind: "opened" });
        // Both messages carry a time from before the open, as a client running behind would.
        const early = iso(NOW - 5 * 60_000);
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES
            ('m-skew-1', 'skewed-draft', 'user', 'Sent from a slow clock.', 0, ${early}, ${early}),
            ('m-skew-2', 'thread-1', 'user', 'Continuing from a slow clock.', 0, ${early}, ${early})
        `;
        const after = yield* ideas.list;
        assert.isUndefined(after.ideas.find((entry) => entry.id === starter!.id));
        assert.isUndefined(after.ideas.find((entry) => entry.id === resume!.id));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("counts a send in a thread that was reverted after the idea was opened", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([threadIdea()]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedWork;
        const ideas = yield* Ideas.make;
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const resume = (yield* ideas.list).ideas.find((entry) => entry.section === "continue");
        assert.isDefined(resume);
        yield* ideas.feedback({ ideaId: resume!.id, kind: "opened" });
        // The user reverts the thread, removing its only message, then sends the idea's draft.
        yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'm1'`;
        yield* TestClock.adjust(HOUR);
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-after-revert', 'thread-1', 'user', 'Please match the remaining lines.', 0, ${iso(NOW + HOUR)}, ${iso(NOW + HOUR)})
        `;
        assert.isUndefined((yield* ideas.list).ideas.find((entry) => entry.id === resume!.id));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
  const featureTitle = (id: string) => FEATURE_IDEAS.find((feature) => feature.id === id)!.title;
  const featureTitles = (snapshot: IdeasSnapshot) =>
    (snapshot.features ?? []).map((idea) => idea.title);

  const useScheduledTasks = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = iso(NOW - DAY);
    yield* sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
        model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
        created_at, updated_at, last_run_status, run_count
      ) VALUES (
        'task-1', 'Weekly recap', 'Recap my week.', 1, '{}', 'project-1', '{}',
        '{}', 'full-access', 'default', 'user', 'web',
        ${at}, ${at}, 'never', 0
      )
    `;
  });

  const useSubagents = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_subagents (
        subagent_id, thread_id, parent_node_id, provider, origin, status, updated_at, payload_json
      ) VALUES ('subagent-1', 'thread-1', 'node-1', 'codex', 'app_owned', 'completed', ${iso(NOW)}, '{}')
    `;
  });

  it.effect("lists untried features apart from other ideas, leaving starter seeding alone", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const snapshot = yield* ideas.list;
        assert.deepStrictEqual(
          featureTitles(snapshot),
          FEATURE_IDEAS.map((feature) => feature.title),
        );
        assert.isTrue((snapshot.features ?? []).every((idea) => idea.section === "feature"));
        assert.isFalse(snapshot.ideas.some((idea) => idea.section === "feature"));
        // Feature cards don't take the starter ideas' places or count as unseen ideas.
        assert.strictEqual(
          snapshot.ideas.filter((idea) => idea.section === "starter").length,
          Math.min(6, GENERAL_STARTERS.length),
        );
        assert.strictEqual(snapshot.unseenCount, snapshot.ideas.length);
        // Listing again doesn't add a second card for any feature.
        assert.strictEqual((yield* ideas.list).features?.length, FEATURE_IDEAS.length);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("skips features already used and retires a card once its feature is tried", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        yield* useScheduledTasks;
        const ideas = yield* Ideas.make;
        const first = yield* ideas.list;
        assert.notInclude(featureTitles(first), featureTitle("scheduled-tasks"));
        assert.include(featureTitles(first), featureTitle("subagents"));

        // A snoozed card is retired too, and checks wait a minute between runs.
        const subagents = first.features!.find((idea) => idea.title === featureTitle("subagents"))!;
        yield* ideas.feedback({
          ideaId: subagents.id,
          kind: "snoozed",
          snoozedUntil: iso(NOW + DAY),
        });
        yield* useSubagents;
        assert.include(featureTitles(yield* ideas.list), featureTitle("subagents"));
        yield* TestClock.adjust(61_000);
        const after = yield* ideas.list;
        assert.notInclude(featureTitles(after), featureTitle("subagents"));
        assert.include(featureTitles(after), featureTitle("visual-replies"));

        // Neither card comes back later.
        yield* TestClock.adjust(30 * DAY);
        const later = yield* ideas.list;
        assert.notInclude(featureTitles(later), featureTitle("subagents"));
        assert.notInclude(featureTitles(later), featureTitle("scheduled-tasks"));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("keeps feature cards past the idea limits until tried, sent, or dismissed", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedWork;
        const ideas = yield* Ideas.make;
        const first = yield* ideas.list;
        const [toDismiss, toSend, toKeep] = first.features!;

        // An opened draft that is never sent keeps its card, unlike a generated idea's.
        yield* ideas.feedback({
          ideaId: toKeep!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("draft-keep"),
        });
        yield* ideas.feedback({
          ideaId: toSend!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("draft-send"),
        });
        yield* ideas.feedback({ ideaId: toDismiss!.id, kind: "dismissed" });
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-feature', 'draft-send', 'user', 'Sent the feature draft.', 0, ${iso(NOW)}, ${iso(NOW)})
        `;
        // Suggest more runs out of starter ideas; trimming the page must not touch feature cards.
        for (let round = 0; round < 6; round++) {
          yield* ideas.suggestMore;
          yield* ideas.awaitIdle;
        }
        yield* TestClock.adjust(20 * DAY);
        const later = yield* ideas.list;
        const ids = (later.features ?? []).map((idea) => idea.id);
        assert.notInclude(ids, toDismiss!.id);
        assert.notInclude(ids, toSend!.id);
        assert.include(ids, toKeep!.id);
        assert.strictEqual(ids.length, FEATURE_IDEAS.length - 2);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
  const addToolCall = (id: string, payload: unknown) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (${id}, 'thread-1', 1, 'dynamic_tool', 'completed', ${iso(NOW)}, ${JSON.stringify(payload)})
      `;
    });

  const chartOutput = (title: string) => ({
    htmlRender: {
      attachmentId:
        "dede31cf-8914-43c7-995a-a66a1af52c79-a6f6bc404758b75c-22a8da64-d6ff-487c-a69d-1dea8da4e05c-html",
      title,
      height: 420,
    },
  });

  it.effect("counts a chart only when the agent showed one, not text that names the tool", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        // Reading the renderer's source names it twice, but shows nothing.
        yield* addToolCall("read-source", {
          toolName: "Read",
          input: { file_path: "apps/server/src/htmlRender/HtmlRender.ts" },
          output: "export const htmlRender = ...; // calls html_render",
        });
        const ideas = yield* Ideas.make;
        assert.include(featureTitles(yield* ideas.list), featureTitle("visual-replies"));

        // Failed renders, more than one page of them, come before the one that worked.
        for (let index = 0; index < 25; index++) {
          yield* addToolCall(`failed-chart-${index}`, {
            toolName: "t3-code.html_render",
            output: { ...chartOutput("Broken chart"), isError: true },
          });
        }
        yield* TestClock.adjust(61_000);
        assert.include(featureTitles(yield* ideas.list), featureTitle("visual-replies"));

        // Some providers store the call's status after its name.
        yield* addToolCall("chart", {
          toolName: "t3-code.html_render completed",
          output: chartOutput("Tickets by month"),
        });
        yield* TestClock.adjust(61_000);
        assert.notInclude(featureTitles(yield* ideas.list), featureTitle("visual-replies"));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("remembers scheduled tasks that were deleted, from the agent's call or a run", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        const ideas = yield* Ideas.make;
        assert.include(featureTitles(yield* ideas.list), featureTitle("scheduled-tasks"));

        // A call that failed, and one that only mentions a task id, are not a scheduled task.
        yield* addToolCall("failed-schedule", {
          toolName: "t3-code.schedule_task",
          output: { isError: true, error: "Invalid schedule", scheduledTaskId: "scheduled-task:x" },
        });
        yield* addToolCall("list-tasks", {
          toolName: "t3-code.list_scheduled_tasks",
          output: { tasks: [{ scheduledTaskId: "scheduled-task:y" }] },
        });
        yield* TestClock.adjust(61_000);
        assert.include(featureTitles(yield* ideas.list), featureTitle("scheduled-tasks"));

        // An agent made a task, and it has since been deleted: no scheduled_tasks row is left.
        yield* addToolCall("schedule", {
          toolName: "mcp__t3-code__schedule_task",
          output: { scheduledTaskId: "scheduled-task:z", title: "Weekly recap" },
        });
        yield* TestClock.adjust(61_000);
        assert.notInclude(featureTitles(yield* ideas.list), featureTitle("scheduled-tasks"));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("counts a deleted scheduled task that ran at least once", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        const ideas = yield* Ideas.make;
        assert.include(featureTitles(yield* ideas.list), featureTitle("scheduled-tasks"));
        yield* seedV2Activity({
          threadId: "scheduled-run",
          projectId: "project-1",
          title: "Weekly recap",
          at: iso(NOW),
          messages: [{ id: "run-message", role: "user", text: "Recap my week." }],
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE orchestration_v2_projection_messages
          SET payload_json = json_set(payload_json, '$.scheduledTaskId', 'scheduled-task:run')
          WHERE message_id = 'run-message'
        `;
        yield* TestClock.adjust(61_000);
        assert.notInclude(featureTitles(yield* ideas.list), featureTitle("scheduled-tasks"));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
  it.effect(
    "retires a snoozed feature card once its draft is sent, even if the feature never ran",
    () =>
      Effect.gen(function* () {
        const { layer } = yield* makeHarness(() => Effect.succeed([]));
        yield* TestClock.setTime(NOW);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedWork;
          const ideas = yield* Ideas.make;
          const helpers = (yield* ideas.list).features!.find(
            (idea) => idea.title === featureTitle("subagents"),
          )!;
          yield* ideas.feedback({
            ideaId: helpers.id,
            kind: "opened",
            draftThreadId: ThreadId.make("draft-helpers"),
          });
          yield* ideas.feedback({
            ideaId: helpers.id,
            kind: "snoozed",
            snoozedUntil: iso(NOW + 7 * DAY),
          });
          // The draft is sent, then stopped before the agent starts any helpers.
          yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-helpers', 'draft-helpers', 'user', 'Compare three meeting setups.', 0, ${iso(NOW)}, ${iso(NOW)})
        `;
          yield* TestClock.adjust(61_000);
          const after = yield* ideas.list;
          assert.notInclude(featureTitles(after), featureTitle("subagents"));
          const [row] = yield* sql<{ readonly status: string }>`
          SELECT status FROM ideas WHERE idea_id = ${helpers.id}
        `;
          assert.strictEqual(row?.status, "sent");
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );
});
