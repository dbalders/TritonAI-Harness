import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { getManagedProviderInstanceRenames } from "../managedPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/**
 * Apply newly observed managed provider collision renames to both event truth
 * and current projections before provider runtimes hydrate. Callers must pass
 * only the provenance-scoped reference renames written by the same settings
 * migration contract, never a legacy collision marker.
 */
export const migrateManagedProviderInstanceReferences = Effect.fn(
  "migrateManagedProviderInstanceReferences",
)(function* (renames: Readonly<Record<string, string>>) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tritonai_managed_policy_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `;

  yield* Effect.forEach(
    Object.entries(renames),
    ([previousInstanceId, nextInstanceId]) => {
      const migrationKey = `provider-instance-rename:${previousInstanceId}:${nextInstanceId}`;
      return sql.withTransaction(
        Effect.gen(function* () {
          const applied = yield* sql<{ readonly migrationKey: string }>`
            SELECT migration_key AS "migrationKey"
            FROM tritonai_managed_policy_migrations
            WHERE migration_key = ${migrationKey}
          `;
          if (applied.length > 0) return;

          yield* sql`
            UPDATE projection_projects
            SET default_model_selection_json = json_set(
              default_model_selection_json,
              '$.instanceId',
              ${nextInstanceId}
            )
            WHERE json_valid(default_model_selection_json)
              AND json_extract(default_model_selection_json, '$.instanceId') = ${previousInstanceId}
          `;
          yield* sql`
            UPDATE projection_threads
            SET model_selection_json = json_set(
              model_selection_json,
              '$.instanceId',
              ${nextInstanceId}
            )
            WHERE json_valid(model_selection_json)
              AND json_extract(model_selection_json, '$.instanceId') = ${previousInstanceId}
          `;
          yield* sql`
            UPDATE projection_thread_sessions
            SET provider_instance_id = ${nextInstanceId}
            WHERE provider_instance_id = ${previousInstanceId}
          `;
          yield* sql`
            UPDATE provider_session_runtime
            SET provider_instance_id = ${nextInstanceId}
            WHERE provider_instance_id = ${previousInstanceId}
          `;
          yield* sql`
            UPDATE provider_session_runtime
            SET runtime_payload_json = json_set(
              runtime_payload_json,
              '$.modelSelection.instanceId',
              ${nextInstanceId}
            )
            WHERE json_valid(runtime_payload_json)
              AND json_extract(runtime_payload_json, '$.modelSelection.instanceId') = ${previousInstanceId}
          `;
          yield* sql`
            UPDATE provider_session_runtime
            SET runtime_payload_json = json_set(
              runtime_payload_json,
              '$.providerInstanceId',
              ${nextInstanceId}
            )
            WHERE json_valid(runtime_payload_json)
              AND json_extract(runtime_payload_json, '$.providerInstanceId') = ${previousInstanceId}
          `;
          for (const path of [
            "$.defaultModelSelection.instanceId",
            "$.modelSelection.instanceId",
            "$.session.providerInstanceId",
          ]) {
            yield* sql`
              UPDATE orchestration_events
              SET payload_json = json_set(payload_json, ${path}, ${nextInstanceId})
              WHERE json_valid(payload_json)
                AND json_extract(payload_json, ${path}) = ${previousInstanceId}
            `;
          }

          yield* sql`
            INSERT INTO tritonai_managed_policy_migrations (migration_key, applied_at)
            VALUES (${migrationKey}, CURRENT_TIMESTAMP)
          `;
        }),
      );
    },
    { discard: true },
  );
});

/** Run the idempotent reference migration after settings and SQLite are ready. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.start;
    yield* migrateManagedProviderInstanceReferences(getManagedProviderInstanceRenames());
  }),
);
