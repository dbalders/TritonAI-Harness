// @effect-diagnostics globalDate:off - fixtures are fixed instants.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type ExecutionEnvironmentDescriptor,
  type IdeasSnapshot,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type GeneratedIdea,
  type IdeasGenerationInput,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import * as Ideas from "./Ideas.ts";
import { STARTER_IDEAS } from "./starterIdeas.ts";

const NOW = Date.parse("2026-10-13T16:00:00.000Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

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
    const layer = Layer.mergeAll(
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
    return { calls, layer };
  });

const titles = (snapshot: IdeasSnapshot) => snapshot.ideas.map((idea) => idea.title);

it.layer(NodeServices.layer)("Ideas", (it) => {
  it.effect("shows starter ideas on a first visit without calling the model", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* makeHarness(() => Effect.succeed([]));
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        const snapshot = yield* ideas.list;
        assert.deepStrictEqual(
          titles(snapshot),
          STARTER_IDEAS.slice(0, 6).map((starter) => starter.title),
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
      const { layer } = yield* makeHarness(() =>
        Effect.succeed([
          threadIdea({ ref: "starter:brainstorm", title: "Brainstorm a team offsite with me" }),
          threadIdea({ ref: "starter:faq", title: "Turn your help desk questions into an FAQ" }),
        ]),
      );
      yield* TestClock.setTime(NOW);
      yield* Effect.gen(function* () {
        const ideas = yield* Ideas.make;
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const first = yield* ideas.list;
        const brainstorm = first.ideas.find((idea) => idea.title.startsWith("Brainstorm"));
        const faq = first.ideas.find((idea) => idea.title.startsWith("Turn your help desk"));
        assert.isDefined(brainstorm);
        assert.isDefined(faq);
        yield* ideas.feedback({ ideaId: brainstorm!.id, kind: "dismissed" });
        yield* ideas.feedback({ ideaId: faq!.id, kind: "rejected" });

        yield* TestClock.adjust(DAY);
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const soon = titles(yield* ideas.list);
        assert.notInclude(soon, "Brainstorm a team offsite with me");
        assert.notInclude(soon, "Turn your help desk questions into an FAQ");

        yield* TestClock.adjust(15 * DAY);
        yield* ideas.suggestMore;
        yield* ideas.awaitIdle;
        const later = titles(yield* ideas.list);
        assert.include(later, "Brainstorm a team offsite with me");
        assert.notInclude(later, "Turn your help desk questions into an FAQ");
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
