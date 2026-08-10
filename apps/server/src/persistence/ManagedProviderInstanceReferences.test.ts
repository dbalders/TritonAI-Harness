import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { migrateManagedProviderInstanceReferences } from "./ManagedProviderInstanceReferences.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("managed provider instance references", (it) => {
  it.effect("renames collision references in event truth and runtime projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const previousInstanceId = "codex_frontier";
      const nextInstanceId = "codex_frontier_personal_2";

      yield* sql`CREATE TABLE projection_projects (default_model_selection_json TEXT)`;
      yield* sql`CREATE TABLE projection_threads (model_selection_json TEXT)`;
      yield* sql`CREATE TABLE projection_thread_sessions (provider_instance_id TEXT)`;
      yield* sql`
        CREATE TABLE provider_session_runtime (
          provider_instance_id TEXT,
          runtime_payload_json TEXT
        )
      `;
      yield* sql`CREATE TABLE orchestration_events (payload_json TEXT)`;

      yield* sql`
        INSERT INTO projection_projects (default_model_selection_json)
        VALUES ('{"instanceId":"codex_frontier","model":"personal-project"}')
      `;
      yield* sql`
        INSERT INTO projection_threads (model_selection_json)
        VALUES ('{"instanceId":"codex_frontier","model":"personal-thread"}')
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (provider_instance_id)
        VALUES (${previousInstanceId})
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (provider_instance_id, runtime_payload_json)
        VALUES (
          ${previousInstanceId},
          '{"providerInstanceId":"codex_frontier","modelSelection":{"instanceId":"codex_frontier","model":"personal-session"}}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (payload_json)
        VALUES ('{"defaultModelSelection":{"instanceId":"codex_frontier","model":"personal-project"},"modelSelection":{"instanceId":"codex_frontier","model":"personal-thread"},"session":{"providerInstanceId":"codex_frontier"}}')
      `;

      yield* migrateManagedProviderInstanceReferences({
        [previousInstanceId]: nextInstanceId,
      });

      const project = yield* sql<{ readonly instanceId: string }>`
        SELECT json_extract(default_model_selection_json, '$.instanceId') AS "instanceId"
        FROM projection_projects
      `;
      const thread = yield* sql<{ readonly instanceId: string }>`
        SELECT json_extract(model_selection_json, '$.instanceId') AS "instanceId"
        FROM projection_threads
      `;
      const threadSession = yield* sql<{ readonly instanceId: string }>`
        SELECT provider_instance_id AS "instanceId" FROM projection_thread_sessions
      `;
      const runtime = yield* sql<{
        readonly instanceId: string;
        readonly payloadInstanceId: string;
        readonly selectionInstanceId: string;
      }>`
        SELECT
          provider_instance_id AS "instanceId",
          json_extract(runtime_payload_json, '$.providerInstanceId') AS "payloadInstanceId",
          json_extract(runtime_payload_json, '$.modelSelection.instanceId') AS "selectionInstanceId"
        FROM provider_session_runtime
      `;
      const event = yield* sql<{
        readonly projectInstanceId: string;
        readonly threadInstanceId: string;
        readonly sessionInstanceId: string;
      }>`
        SELECT
          json_extract(payload_json, '$.defaultModelSelection.instanceId') AS "projectInstanceId",
          json_extract(payload_json, '$.modelSelection.instanceId') AS "threadInstanceId",
          json_extract(payload_json, '$.session.providerInstanceId') AS "sessionInstanceId"
        FROM orchestration_events
      `;

      assert.deepStrictEqual(project, [{ instanceId: nextInstanceId }]);
      assert.deepStrictEqual(thread, [{ instanceId: nextInstanceId }]);
      assert.deepStrictEqual(threadSession, [{ instanceId: nextInstanceId }]);
      assert.deepStrictEqual(runtime, [
        {
          instanceId: nextInstanceId,
          payloadInstanceId: nextInstanceId,
          selectionInstanceId: nextInstanceId,
        },
      ]);
      assert.deepStrictEqual(event, [
        {
          projectInstanceId: nextInstanceId,
          threadInstanceId: nextInstanceId,
          sessionInstanceId: nextInstanceId,
        },
      ]);

      yield* sql`
        INSERT INTO projection_thread_sessions (provider_instance_id)
        VALUES (${previousInstanceId})
      `;
      yield* migrateManagedProviderInstanceReferences({
        [previousInstanceId]: nextInstanceId,
      });
      const threadSessionsAfterRestart = yield* sql<{ readonly instanceId: string }>`
        SELECT provider_instance_id AS "instanceId"
        FROM projection_thread_sessions
        ORDER BY rowid
      `;
      assert.deepStrictEqual(threadSessionsAfterRestart, [
        { instanceId: nextInstanceId },
        { instanceId: previousInstanceId },
      ]);
    }),
  );
});

const routeLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

routeLayer("managed provider route split", (it) => {
  it.effect("moves legacy Codex frontier-model references to the managed frontier route", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const previousInstanceId = "codex";
      const nextInstanceId = "codex_frontier";
      const frontierModel = "gpt-5.6-sol";

      yield* sql`CREATE TABLE projection_projects (default_model_selection_json TEXT)`;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          model_selection_json TEXT
        )
      `;
      yield* sql`
        CREATE TABLE projection_thread_sessions (
          thread_id TEXT PRIMARY KEY,
          provider_instance_id TEXT
        )
      `;
      yield* sql`
        CREATE TABLE provider_session_runtime (
          provider_instance_id TEXT,
          runtime_payload_json TEXT
        )
      `;
      yield* sql`CREATE TABLE orchestration_events (payload_json TEXT)`;

      yield* sql`
        INSERT INTO projection_projects (default_model_selection_json)
        VALUES ('{"instanceId":"codex","model":"gpt-5.6-sol"}')
      `;
      yield* sql`
        INSERT INTO projection_projects (default_model_selection_json)
        VALUES ('{"instanceId":"codex","model":"api-deepseek-v4-flash"}')
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, model_selection_json)
        VALUES ('frontier-thread', '{"instanceId":"codex","model":"gpt-5.6-sol"}')
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, model_selection_json)
        VALUES ('on-prem-thread', '{"instanceId":"codex","model":"api-deepseek-v4-flash"}')
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, provider_instance_id)
        VALUES ('frontier-thread', ${previousInstanceId})
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, provider_instance_id)
        VALUES ('on-prem-thread', ${previousInstanceId})
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (provider_instance_id, runtime_payload_json)
        VALUES (
          ${previousInstanceId},
          '{"providerInstanceId":"codex","modelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}'
        )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (provider_instance_id, runtime_payload_json)
        VALUES (
          ${previousInstanceId},
          '{"providerInstanceId":"codex","modelSelection":{"instanceId":"codex","model":"api-deepseek-v4-flash"}}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (payload_json)
        VALUES ('{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"},"modelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"},"session":{"providerInstanceId":"codex"}}')
      `;
      yield* sql`
        INSERT INTO orchestration_events (payload_json)
        VALUES (
          '{"defaultModelSelection":{"instanceId":"codex","model":"api-deepseek-v4-flash"},"modelSelection":{"instanceId":"codex","model":"api-deepseek-v4-flash"},"session":{"providerInstanceId":"codex"}}'
        )
      `;

      const routeSplit = {
        previousInstanceId,
        nextInstanceId,
        frontierModelIds: [frontierModel],
      };
      yield* migrateManagedProviderInstanceReferences({}, routeSplit);

      const project = yield* sql<{ readonly instanceId: string }>`
        SELECT json_extract(default_model_selection_json, '$.instanceId') AS "instanceId"
        FROM projection_projects
        ORDER BY rowid
      `;
      const thread = yield* sql<{ readonly instanceId: string }>`
        SELECT json_extract(model_selection_json, '$.instanceId') AS "instanceId"
        FROM projection_threads
        ORDER BY rowid
      `;
      const threadSession = yield* sql<{ readonly instanceId: string }>`
        SELECT provider_instance_id AS "instanceId"
        FROM projection_thread_sessions
        ORDER BY rowid
      `;
      const runtime = yield* sql<{
        readonly instanceId: string;
        readonly payloadInstanceId: string;
        readonly selectionInstanceId: string;
      }>`
        SELECT
          provider_instance_id AS "instanceId",
          json_extract(runtime_payload_json, '$.providerInstanceId') AS "payloadInstanceId",
          json_extract(runtime_payload_json, '$.modelSelection.instanceId') AS "selectionInstanceId"
        FROM provider_session_runtime
        ORDER BY rowid
      `;
      const event = yield* sql<{
        readonly projectInstanceId: string;
        readonly threadInstanceId: string;
        readonly sessionInstanceId: string;
      }>`
        SELECT
          json_extract(payload_json, '$.defaultModelSelection.instanceId') AS "projectInstanceId",
          json_extract(payload_json, '$.modelSelection.instanceId') AS "threadInstanceId",
          json_extract(payload_json, '$.session.providerInstanceId') AS "sessionInstanceId"
        FROM orchestration_events
        ORDER BY rowid
      `;

      assert.deepStrictEqual(project, [
        { instanceId: nextInstanceId },
        { instanceId: previousInstanceId },
      ]);
      assert.deepStrictEqual(thread, [
        { instanceId: nextInstanceId },
        { instanceId: previousInstanceId },
      ]);
      assert.deepStrictEqual(threadSession, [
        { instanceId: nextInstanceId },
        { instanceId: previousInstanceId },
      ]);
      assert.deepStrictEqual(runtime, [
        {
          instanceId: nextInstanceId,
          payloadInstanceId: nextInstanceId,
          selectionInstanceId: nextInstanceId,
        },
        {
          instanceId: previousInstanceId,
          payloadInstanceId: previousInstanceId,
          selectionInstanceId: previousInstanceId,
        },
      ]);
      assert.deepStrictEqual(event, [
        {
          projectInstanceId: nextInstanceId,
          threadInstanceId: nextInstanceId,
          sessionInstanceId: nextInstanceId,
        },
        {
          projectInstanceId: previousInstanceId,
          threadInstanceId: previousInstanceId,
          sessionInstanceId: previousInstanceId,
        },
      ]);

      yield* sql`
        INSERT INTO projection_projects (default_model_selection_json)
        VALUES ('{"instanceId":"codex","model":"gpt-5.6-sol"}')
      `;
      yield* migrateManagedProviderInstanceReferences({}, routeSplit);
      const projectsAfterRestart = yield* sql<{ readonly instanceId: string }>`
        SELECT json_extract(default_model_selection_json, '$.instanceId') AS "instanceId"
        FROM projection_projects
        ORDER BY rowid
      `;
      assert.deepStrictEqual(projectsAfterRestart, [
        { instanceId: nextInstanceId },
        { instanceId: previousInstanceId },
        { instanceId: previousInstanceId },
      ]);

      const laterFrontierModel = "claude-opus-5";
      yield* sql`
        INSERT INTO projection_projects (default_model_selection_json)
        VALUES (
          '{"instanceId":"codex","model":"claude-opus-5"}'
        )
      `;
      yield* migrateManagedProviderInstanceReferences(
        {},
        {
          ...routeSplit,
          frontierModelIds: [frontierModel, laterFrontierModel],
        },
      );
      const projectsAfterCatalogExpansion = yield* sql<{ readonly instanceId: string }>`
        SELECT json_extract(default_model_selection_json, '$.instanceId') AS "instanceId"
        FROM projection_projects
        ORDER BY rowid
      `;
      assert.deepStrictEqual(projectsAfterCatalogExpansion, [
        { instanceId: nextInstanceId },
        { instanceId: previousInstanceId },
        { instanceId: previousInstanceId },
        { instanceId: nextInstanceId },
      ]);
    }),
  );
});
