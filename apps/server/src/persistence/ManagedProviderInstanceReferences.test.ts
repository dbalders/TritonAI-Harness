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
