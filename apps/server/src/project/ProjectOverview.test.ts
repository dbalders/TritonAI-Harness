import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, TextGenerationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as DailyMemory from "../memory/DailyMemory.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { seedV2Activity } from "../persistence/HarnessActivity.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type IdeasGenerationInput,
  type IdeasGenerationResult,
  TextGeneration,
} from "../textGeneration/TextGeneration.ts";
import * as ProjectOverview from "./ProjectOverview.ts";

const projectId = ProjectId.make("project-1");
const input = { projectId };
const at = "2026-10-17T12:00:00.000Z";
const result = (description = "Prepare a reviewed Teams pilot."): IdeasGenerationResult => ({
  description,
  ideas: [
    {
      ref: "thread:thread-1",
      sources: ["thread:thread-1"],
      topic: "review pilot",
      icon: "✓",
      title: "Review the pilot checklist",
      body: "The checklist is drafted and still needs owner review.",
      action: "new-thread",
      projectId,
      prompt: "Review the pilot checklist and identify the remaining decisions.",
    },
  ],
});
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Pilot','/project/pilot','[]',${at},${at})`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,created_at,updated_at)
    VALUES ('thread-1',${projectId},'Draft checklist',${at},${at})`;
  yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at)
    VALUES ('m1','thread-1','user','Prepare a pilot checklist for review.',0,${at},${at})`;
});
const harness = (
  generate: (
    input: IdeasGenerationInput,
  ) => Effect.Effect<IdeasGenerationResult, TextGenerationError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "project-overview-" });
    const calls: IdeasGenerationInput[] = [];
    const layer = Layer.mergeAll(
      ServerSettings.layerTest({ memoryEnabled: false }),
      Layer.mock(DailyMemory.DailyMemory)({
        getProjectMemory: () =>
          Effect.succeed({
            projectId,
            state: "disabled",
            markdown: null,
            updatedAt: null,
            relativePath: null,
            recentUpdates: [],
          }),
      }),
      Layer.mock(TextGeneration)({
        generateIdeas: (request) =>
          Effect.sync(() => calls.push(request)).pipe(Effect.andThen(generate(request))),
      }),
    ).pipe(Layer.provideMerge(layerMemory), Layer.provideMerge(ServerConfig.layerTest(dir, dir)));
    return { calls, layer };
  });

it.layer(NodeServices.layer)("ProjectOverview", (it) => {
  it.effect("persists the result and reuses unchanged context across service restarts", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* harness(() => Effect.succeed(result()));
      yield* Effect.gen(function* () {
        yield* seed;
        const service = yield* ProjectOverview.make;
        assert.isNull((yield* service.get(input)).overview);
        yield* service.ensure(input);
        yield* service.awaitIdle(projectId);
        const saved = yield* service.get(input);
        assert.equal(saved.overview?.description, result().description);
        assert.equal(saved.overview?.nextSteps.length, 1);
        assert.equal(saved.generation.state, "idle");
        const restarted = yield* ProjectOverview.make;
        yield* restarted.ensure(input);
        assert.deepStrictEqual((yield* restarted.get(input)).overview, saved.overview);
        assert.lengthOf(calls, 1);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET updated_at='2026-10-18T12:00:00.000Z' WHERE thread_id='thread-1'`;
        yield* restarted.ensure(input);
        assert.lengthOf(calls, 1);
        yield* sql`UPDATE projection_thread_messages SET text='Owner reviewed the draft; prepare revisions.' WHERE message_id='m1'`;
        yield* restarted.ensure(input);
        yield* restarted.awaitIdle(projectId);
        assert.lengthOf(calls, 2);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect(
    "keeps the cache during refresh, joins concurrent requests, and retains it on failure",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<IdeasGenerationResult, TextGenerationError>();
        let count = 0;
        const { calls, layer } = yield* harness(() =>
          Effect.suspend(() =>
            ++count === 1
              ? Effect.succeed(result())
              : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          ),
        );
        yield* Effect.gen(function* () {
          yield* seed;
          const service = yield* ProjectOverview.make;
          yield* service.ensure(input);
          yield* service.awaitIdle(projectId);
          const saved = (yield* service.get(input)).overview;
          yield* service.ensure({ ...input, force: true });
          yield* Deferred.await(entered);
          yield* service.ensure({ ...input, force: true });
          const pending = yield* service.get(input);
          assert.equal(pending.generation.state, "generating");
          assert.deepStrictEqual(pending.overview, saved);
          assert.lengthOf(calls, 2);
          yield* Deferred.fail(
            finish,
            new TextGenerationError({ detail: "Provider unavailable", operation: "generateIdeas" }),
          );
          yield* service.awaitIdle(projectId);
          assert.equal((yield* service.get(input)).generation.state, "error");
          assert.deepStrictEqual((yield* service.get(input)).overview, saved);
          const subscribed = yield* Deferred.make<void>();
          const updates = yield* service.subscribe(input).pipe(
            Stream.tap(() => Deferred.succeed(subscribed, undefined)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Deferred.await(subscribed);
          yield* service.ensure(input);
          assert.deepStrictEqual(
            (yield* Fiber.join(updates)).map((snapshot) => snapshot.generation.state),
            ["error", "idle"],
          );
          assert.lengthOf(calls, 2);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
  );

  it.effect("uses authoritative project messages and rejects unrelated sources", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* harness(() =>
        Effect.succeed({
          ...result(),
          ideas: [
            ...result().ideas,
            { ...result().ideas[0]!, ref: "thread:foreign", sources: ["thread:foreign"] },
            { ...result().ideas[0]!, projectId: "another-project" },
          ],
        }),
      );
      yield* Effect.gen(function* () {
        yield* seed;
        yield* seedV2Activity({
          projectId,
          threadId: "thread-1",
          title: "Current checklist",
          at,
          messages: [
            { id: "m1", role: "user", text: "Authoritative checklist request" },
            {
              id: "streaming",
              role: "assistant",
              text: "Incomplete streaming report",
              streaming: true,
            },
          ],
        });
        yield* seedV2Activity({
          projectId: "another-project",
          threadId: "foreign",
          title: "Unrelated",
          at,
          messages: [{ id: "foreign-message", role: "user", text: "Private unrelated context" }],
        });
        yield* seedV2Activity({
          projectId,
          threadId: "archived",
          title: "Archived",
          at,
          messages: [{ id: "archive-message", role: "user", text: "Archived source text" }],
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at=${at} WHERE thread_id='archived'`;
        const service = yield* ProjectOverview.make;
        yield* service.ensure(input);
        yield* service.awaitIdle(projectId);
        assert.include(calls[0]!.context, "Authoritative checklist request");
        for (const text of [
          "Prepare a pilot checklist for review.",
          "Incomplete streaming report",
          "Private unrelated context",
          "Archived source text",
        ])
          assert.notInclude(calls[0]!.context, text);
        assert.equal((yield* service.get(input)).overview?.nextSteps.length, 1);
        yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at=${at} WHERE thread_id='thread-1'`;
        assert.isNull((yield* service.get(input)).overview);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("does not invoke a model without context", () =>
    Effect.gen(function* () {
      const { calls, layer } = yield* harness(() => Effect.succeed(result()));
      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM projection_thread_messages`;
        const service = yield* ProjectOverview.make;
        const empty = yield* service.ensure(input);
        assert.isFalse(empty.contextAvailable);
        assert.equal(empty.generation.state, "idle");
        assert.lengthOf(calls, 0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("does not write stale results or stay generating after the project moves", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<IdeasGenerationResult>();
      const { layer } = yield* harness(() =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      );
      yield* Effect.gen(function* () {
        yield* seed;
        const service = yield* ProjectOverview.make;
        yield* service.ensure(input);
        yield* Deferred.await(entered);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_projects SET workspace_root='/new/location' WHERE project_id=${projectId}`;
        yield* Deferred.succeed(finish, result());
        yield* service.awaitIdle(projectId);
        assert.isNull((yield* service.get(input)).overview);
        assert.equal((yield* service.get(input)).generation.state, "error");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
