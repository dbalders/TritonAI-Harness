import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { getManagedProviderInstanceRenames } from "../managedPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";

// Only host-owned routing fields are rewritten. Tool inputs/outputs, prompts,
// model names and driver identities remain uninterpreted data.
const V2_REFERENCE_TABLES = [
  "orchestration_v2_events",
  "orchestration_v2_projection_threads",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_provider_sessions",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_context_transfers",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_turn_items",
] as const;
const V2_REFERENCE_PATHS = [
  "$.providerInstanceId",
  "$.modelSelection.instanceId",
  "$.sourceProviderInstanceId",
  "$.targetProviderInstanceId",
  "$.targetModelSelection.instanceId",
  "$.toProviderInstanceId",
] as const;

const migrateV2References = Effect.fn("migrateV2ManagedProviderReferences")(function* (
  renames: Readonly<Record<string, string>>,
) {
  const sql = yield* SqlClient.SqlClient;
  const existing = new Set(
    (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`).map(
      ({ name }) => name,
    ),
  );
  if (!existing.has("orchestration_v2_events")) return;
  for (const [previous, next] of Object.entries(renames)) {
    const key = `provider-instance-rename-v2:${previous}:${next}`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (
          (yield* sql`SELECT 1 FROM tritonai_managed_policy_migrations WHERE migration_key = ${key}`)
            .length > 0
        )
          return;
        for (const table of V2_REFERENCE_TABLES) {
          if (!existing.has(table)) continue;
          const columns = new Set(
            (yield* sql<{ name: string }>`PRAGMA table_info(${sql(table)})`).map(
              ({ name }) => name,
            ),
          );
          for (const column of [
            "provider_instance_id",
            "source_provider_instance_id",
            "target_provider_instance_id",
          ]) {
            if (columns.has(column))
              yield* sql`UPDATE ${sql(table)} SET ${sql(column)} = ${next} WHERE ${sql(column)} = ${previous}`;
          }
          for (const path of V2_REFERENCE_PATHS) {
            yield* sql`UPDATE ${sql(table)} SET payload_json = json_set(payload_json, ${path}, ${next})
            WHERE json_valid(payload_json) AND json_extract(payload_json, ${path}) = ${previous}`;
          }
          yield* sql`UPDATE ${sql(table)} SET payload_json = json_set(payload_json, '$.fromProviderInstanceIds',
          (SELECT json_group_array(CASE WHEN value = ${previous} THEN ${next} ELSE value END)
           FROM json_each(payload_json, '$.fromProviderInstanceIds')))
          WHERE json_valid(payload_json) AND json_type(payload_json, '$.fromProviderInstanceIds') = 'array'
            AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.fromProviderInstanceIds') WHERE value = ${previous})`;
          yield* sql`UPDATE ${sql(table)} SET payload_json = json_set(payload_json, '$.fromModelSelections',
          (SELECT json_group_array(json(CASE WHEN json_extract(value, '$.instanceId') = ${previous}
            THEN json_set(value, '$.instanceId', ${next}) ELSE value END))
           FROM json_each(payload_json, '$.fromModelSelections')))
          WHERE json_valid(payload_json) AND json_type(payload_json, '$.fromModelSelections') = 'array'
            AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.fromModelSelections') WHERE json_extract(value, '$.instanceId') = ${previous})`;
        }
        if (existing.has("scheduled_tasks")) {
          yield* sql`UPDATE scheduled_tasks SET model_selection_json = json_set(model_selection_json, '$.instanceId', ${next})
          WHERE json_valid(model_selection_json) AND json_extract(model_selection_json, '$.instanceId') = ${previous}`;
        }
        yield* sql`INSERT INTO tritonai_managed_policy_migrations (migration_key, applied_at) VALUES (${key}, CURRENT_TIMESTAMP)`;
      }),
    );
  }
});

/**
 * Apply newly observed managed provider collision renames to both event truth
 * and current projections before provider runtimes hydrate. Callers must pass
 * only the provenance-scoped reference renames written by the same settings
 * migration contract, never a legacy collision marker.
 */
export const migrateManagedProviderInstanceReferences = Effect.fn(
  "migrateManagedProviderInstanceReferences",
)(function* (renames: Readonly<Record<string, string>>) {
  if (Object.keys(renames).length === 0) return;
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
  yield* migrateV2References(renames);
});

/** Repair provider identity collisions without rewriting historical model choices. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.start;
    yield* migrateManagedProviderInstanceReferences(getManagedProviderInstanceRenames());
  }),
);
