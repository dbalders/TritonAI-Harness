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

  it.effect("reports visits, presses, sends, and runs as anonymous counts", () =>
    Effect.gen(function* () {
      const { events, layer } = yield* makeHarness(() => Effect.succeed([threadIdea()]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedWork;
        const ideas = yield* Ideas.make;
        yield* ideas.markViewed;
        yield* ideas.awaitIdle;
        // Marking the page viewed again as ideas arrive is the same visit.
        yield* ideas.markViewed;
        const [idea] = (yield* ideas.list).ideas.filter((entry) => entry.section === "continue");
        yield* ideas.feedback({ ideaId: idea!.id, kind: "opened" });
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-send', 'thread-1', 'user', 'Please match the rest.', 0, ${iso(NOW + 1)}, ${iso(NOW + 1)})
        `;
        yield* TestClock.adjust(HOUR);
        yield* ideas.list;
        assert.deepStrictEqual(events, [
          {
            event: "ideas.viewed",
            properties: { visibleCount: 6, personalCount: 0, toolCount: 0, starterCount: 6 },
          },
          {
            event: "ideas.generated",
            properties: {
              requested: false,
              outcome: "generated",
              generatedCount: 1,
              starterCount: 0,
            },
          },
          { event: "ideas.feedback", properties: { kind: "opened", section: "continue" } },
          { event: "ideas.sent", properties: { section: "continue" } },
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("shows starter ideas on a first visit without calling the model", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const snapshot = yield* ideas.list;
        assert.deepStrictEqual(
          titles(snapshot),
          GENERAL_STARTERS.slice(0, 6).map((starter) => starter.title),
        );
        assert.isTrue(snapshot.ideas.every((idea) => idea.section === "starter"));
        assert.strictEqual(snapshot.unseenCount, 6);
        assert.strictEqual(calls.length, 0);
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

  it.effect("skips the model on a first visit with nothing of the user's own to go on", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness(() => Effect.succeed([threadIdea()]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const viewed = yield* ideas.markViewed;
        yield* ideas.awaitIdle;
        const snapshot = yield* ideas.list;
        assert.strictEqual(calls.length, 0);
        assert.strictEqual(snapshot.ideas.length, viewed.ideas.length);
        assert.isNull(snapshot.message);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("does not pad the page with starter ideas when a background run finds nothing", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        const ideas = yield* Ideas.make;
        const viewed = yield* ideas.markViewed;
        yield* ideas.awaitIdle;
        const snapshot = yield* ideas.list;
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(snapshot.ideas.length, viewed.ideas.length);
        assert.isNull(snapshot.message);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("always adds ideas when the model fails", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() =>
        Effect.fail(new TextGenerationError({ operation: "generateIdeas", detail: "offline" })),
      );
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const before = yield* ideas.list;
        const started = yield* ideas.suggestMore;
        assert.strictEqual(started.state, "generating");
        yield* ideas.awaitIdle;
        const after = yield* ideas.list;
        assert.strictEqual(after.ideas.length, before.ideas.length + 4);
        assert.strictEqual(after.state, "idle");
        assert.include(after.message ?? "", "starter ideas");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("brings dismissed ideas back after two weeks but never rejected ones", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const [dismissed, rejected] = (yield* ideas.list).ideas;
        yield* ideas.feedback({ ideaId: dismissed!.id, kind: "dismissed" });
        yield* ideas.feedback({ ideaId: rejected!.id, kind: "rejected" });

        yield* TestClock.adjust(DAY);
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const soon = titles(yield* ideas.list);
        assert.notInclude(soon, dismissed!.title);
        assert.notInclude(soon, rejected!.title);

        // Once the unshown starters run out, those whose cooldown ended come back.
        yield* TestClock.adjust(15 * DAY);
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const later = titles(yield* ideas.list);
        assert.include(later, dismissed!.title);
        assert.notInclude(later, rejected!.title);
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

  it.effect("counts a starter idea as used when its prompt is sent", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ideas = yield* Ideas.make;
        const starter = GENERAL_STARTERS[1]!;
        const idea = (yield* ideas.list).ideas.find((entry) => entry.title === starter.title);
        assert.isDefined(idea);
        yield* ideas.feedback({ ideaId: idea!.id, kind: "opened" });
        yield* TestClock.adjust(HOUR);
        const sent = `${starter.prompt} Keep it short.`;
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-sent', 'thread-x', 'user', ${sent}, 0, ${iso(NOW + HOUR)}, ${iso(NOW + HOUR)})
        `;
        assert.isUndefined((yield* ideas.list).ideas.find((entry) => entry.id === idea!.id));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("shows an idea from the user's work again when a long snooze ends", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([threadIdea()]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        const ideas = yield* Ideas.make;
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const idea = (yield* ideas.list).ideas.find((entry) => entry.section === "continue");
        assert.isDefined(idea);
        yield* ideas.feedback({
          ideaId: idea!.id,
          kind: "snoozed",
          snoozedUntil: iso(NOW + 5 * DAY),
        });
        yield* TestClock.adjust(6 * DAY);
        assert.isDefined((yield* ideas.list).ideas.find((entry) => entry.id === idea!.id));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("counts an idea as used when its draft's thread gets a message, whatever it says", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ideas = yield* Ideas.make;
        const [idea] = (yield* ideas.list).ideas;
        assert.isDefined(idea);
        const opened = yield* ideas.feedback({
          ideaId: idea!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("draft-thread-1"),
        });
        assert.deepStrictEqual(
          opened.ideas.find((entry) => entry.id === idea!.id)?.draftThreadIds,
          [ThreadId.make("draft-thread-1")],
        );
        yield* TestClock.adjust(HOUR);
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-rewritten', 'draft-thread-1', 'user', 'Something else entirely.', 0, ${iso(NOW + HOUR)}, ${iso(NOW + HOUR)})
        `;
        assert.isUndefined((yield* ideas.list).ideas.find((entry) => entry.id === idea!.id));
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

  it.effect("lets ideas about tools go stale like ideas about the user's own work", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const content = yield* encodeIdeaContent({
          icon: "🎫",
          title: "I can report the Jira access problem",
          body: "Issue searches were denied.",
          sources: [{ kind: "plugin", label: "Plugin · UC San Diego Jira" }],
          action: { kind: "new-thread", projectId: null, prompt: "Report the Jira search error." },
        });
        yield* sql`
          INSERT INTO ideas (idea_id, idea_key, section, content_json, status, created_at, updated_at)
          VALUES ('jira', 'plugin:jira-data-center#report-access', 'tools', ${content}, 'active', ${iso(NOW)}, ${iso(NOW)})
        `;
        const ideas = yield* Ideas.make;
        assert.include(titles(yield* ideas.list), "I can report the Jira access problem");
        yield* TestClock.adjust(3 * DAY + HOUR);
        const later = yield* ideas.list;
        assert.notInclude(titles(later), "I can report the Jira access problem");
        assert.isTrue(later.ideas.every((idea) => idea.section === "starter"));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("keeps one project to two ideas on the page", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() =>
        Effect.succeed(
          (
            [
              ["thread-1", "I can finish the travel reconciliation"],
              ["thread-2", "I can chart the parking budget"],
              ["thread-3", "I can summarize the vendor contracts"],
            ] as const
          ).map(([id, title]) =>
            threadIdea({ ref: `thread:${id}`, sources: [`thread:${id}`], topic: title, title }),
          ),
        ),
      );
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        for (const id of ["thread-2", "thread-3"]) {
          yield* seedV2Activity({
            threadId: id,
            projectId: "project-1",
            title: `Budget task ${id}`,
            at: iso(NOW - DAY),
            messages: [{ id: `${id}-m`, role: "user", text: `Work on ${id}` }],
          });
        }
        const ideas = yield* Ideas.make;
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const fromProject = (yield* ideas.list).ideas.filter(
          (idea) => idea.action.kind === "resume-thread",
        );
        assert.strictEqual(fromProject.length, 2);

        // Snoozed ideas keep their place, so the third can't take it and leave three after they wake.
        for (const idea of fromProject) {
          yield* ideas.feedback({
            ideaId: idea.id,
            kind: "snoozed",
            snoozedUntil: iso(NOW + HOUR),
          });
        }
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        yield* TestClock.adjust(2 * HOUR);
        const woken = (yield* ideas.list).ideas.filter(
          (idea) => idea.action.kind === "resume-thread",
        );
        assert.strictEqual(woken.length, 2);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("stops background runs after two days away and checks again on the next visit", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness(() => Effect.succeed([threadIdea()]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        const ideas = yield* Ideas.make;
        yield* ideas.markViewed;
        yield* ideas.awaitIdle;
        assert.strictEqual(calls.length, 1);
        yield* TestClock.adjust(2 * DAY + HOUR);
        yield* ideas.refresh;
        assert.strictEqual(calls.length, 1);
        const viewed = yield* ideas.markViewed;
        assert.strictEqual(viewed.state, "generating");
        yield* ideas.awaitIdle;
        assert.strictEqual(calls.length, 2);
        // A fresh page doesn't start another run on every visit.
        yield* ideas.markViewed;
        yield* ideas.awaitIdle;
        assert.strictEqual(calls.length, 2);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("shows an opened idea again when a long snooze ends", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const [idea] = (yield* ideas.list).ideas;
        yield* ideas.feedback({
          ideaId: idea!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("draft-thread-2"),
        });
        yield* ideas.feedback({
          ideaId: idea!.id,
          kind: "snoozed",
          snoozedUntil: iso(NOW + 5 * DAY),
        });
        yield* TestClock.adjust(6 * DAY);
        const woke = (yield* ideas.list).ideas.find((entry) => entry.id === idea!.id);
        assert.isDefined(woke);
        assert.isNotNull(woke!.openedAt);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("retires an opened idea when the thread it continues is deleted", () =>
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
        yield* ideas.feedback({ ideaId: idea!.id, kind: "opened" });
        yield* sql`UPDATE projection_threads SET deleted_at = ${iso(NOW)} WHERE thread_id = 'thread-1'`;
        assert.isUndefined((yield* ideas.list).ideas.find((entry) => entry.id === idea!.id));
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

  it.effect("counts an idea as used when a draft opened on another client is sent", () =>
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
          draftThreadId: ThreadId.make("desktop-draft"),
        });
        const both = yield* ideas.feedback({
          ideaId: idea!.id,
          kind: "opened",
          draftThreadId: ThreadId.make("browser-draft"),
        });
        assert.deepStrictEqual(both.ideas.find((entry) => entry.id === idea!.id)?.draftThreadIds, [
          ThreadId.make("desktop-draft"),
          ThreadId.make("browser-draft"),
        ]);
        yield* TestClock.adjust(HOUR);
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('m-desktop', 'desktop-draft', 'user', 'Sent from the desktop draft.', 0, ${iso(NOW + HOUR)}, ${iso(NOW + HOUR)})
        `;
        assert.isUndefined((yield* ideas.list).ideas.find((entry) => entry.id === idea!.id));
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
        yield* Effect.all(
          ["desktop-draft", "browser-draft", "desktop-draft"].map((draft) =>
            ideas.feedback({
              ideaId: idea!.id,
              kind: "opened",
              draftThreadId: ThreadId.make(draft),
            }),
          ),
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

  it.effect("keeps a snoozed idea snoozed when asked to dismiss it", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const [idea] = (yield* ideas.list).ideas;
        yield* ideas.feedback({ ideaId: idea!.id, kind: "snoozed", snoozedUntil: iso(NOW + DAY) });
        const after = yield* ideas.feedback({ ideaId: idea!.id, kind: "dismissed" });
        assert.deepStrictEqual(
          after.snoozed.map((entry) => entry.id),
          [idea!.id],
        );
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("refreshes a full page at least daily while Ideas is in use", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness(() => Effect.succeed([threadIdea()]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        yield* seedWork;
        const ideas = yield* Ideas.make;
        yield* ideas.markViewed;
        yield* ideas.awaitIdle;
        assert.strictEqual(calls.length, 1);
        yield* TestClock.adjust(5 * HOUR);
        yield* ideas.refresh;
        assert.strictEqual(calls.length, 1);
        yield* TestClock.adjust(20 * HOUR);
        yield* ideas.refresh;
        assert.strictEqual(calls.length, 2);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("snoozes until the chosen time and undoes a dismissal", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const [first, second] = (yield* ideas.list).ideas;
        assert.isDefined(first);
        assert.isDefined(second);

        const snoozed = yield* ideas.feedback({
          ideaId: first!.id,
          kind: "snoozed",
          snoozedUntil: iso(NOW + HOUR),
        });
        assert.deepStrictEqual(
          snoozed.snoozed.map((idea) => idea.id),
          [first!.id],
        );
        assert.isUndefined(snoozed.ideas.find((idea) => idea.id === first!.id));

        yield* TestClock.adjust(2 * HOUR);
        const woke = yield* ideas.list;
        assert.isDefined(woke.ideas.find((idea) => idea.id === first!.id));
        assert.strictEqual(woke.snoozed.length, 0);

        const dismissed = yield* ideas.feedback({ ideaId: second!.id, kind: "dismissed" });
        assert.isUndefined(dismissed.ideas.find((idea) => idea.id === second!.id));
        const restored = yield* ideas.feedback({ ideaId: second!.id, kind: "restored" });
        assert.isDefined(restored.ideas.find((idea) => idea.id === second!.id));
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
