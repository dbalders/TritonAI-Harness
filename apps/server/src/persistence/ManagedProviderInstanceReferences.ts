import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { getManagedProviderInstanceRenames, managedConfig } from "../managedPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/**
 * Apply newly observed managed provider collision renames to both event truth
 * and current projections before provider runtimes hydrate. Callers must pass
 * only the provenance-scoped reference renames written by the same settings
 * migration contract, never a legacy collision marker.
 */
export const migrateManagedProviderInstanceReferences = Effect.fn(
  "migrateManagedProviderInstanceReferences",
)(function* (
  renames: Readonly<Record<string, string>>,
  routeSplit?: {
    readonly previousInstanceId: string;
    readonly nextInstanceId: string;
    readonly frontierModelIds: readonly string[];
  },
) {
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

  if (routeSplit && routeSplit.frontierModelIds.length > 0) {
    yield* Effect.forEach(
      routeSplit.frontierModelIds,
      (modelId) => {
        const migrationKey = `provider-route-split:${routeSplit.previousInstanceId}:${routeSplit.nextInstanceId}:${modelId}`;
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
                ${routeSplit.nextInstanceId}
              )
              WHERE json_valid(default_model_selection_json)
                AND json_extract(default_model_selection_json, '$.instanceId') = ${routeSplit.previousInstanceId}
                AND json_extract(default_model_selection_json, '$.model') = ${modelId}
            `;
            yield* sql`
              UPDATE projection_threads
              SET model_selection_json = json_set(
                model_selection_json,
                '$.instanceId',
                ${routeSplit.nextInstanceId}
              )
              WHERE json_valid(model_selection_json)
                AND json_extract(model_selection_json, '$.instanceId') = ${routeSplit.previousInstanceId}
                AND json_extract(model_selection_json, '$.model') = ${modelId}
            `;
            yield* sql`
              UPDATE projection_thread_sessions
              SET provider_instance_id = ${routeSplit.nextInstanceId}
              WHERE provider_instance_id = ${routeSplit.previousInstanceId}
                AND EXISTS (
                  SELECT 1
                  FROM projection_threads
                  WHERE projection_threads.thread_id = projection_thread_sessions.thread_id
                    AND json_valid(projection_threads.model_selection_json)
                    AND json_extract(projection_threads.model_selection_json, '$.model') = ${modelId}
                )
            `;
            yield* sql`
              UPDATE provider_session_runtime
              SET
                provider_instance_id = ${routeSplit.nextInstanceId},
                runtime_payload_json = json_set(
                  runtime_payload_json,
                  '$.modelSelection.instanceId',
                  ${routeSplit.nextInstanceId},
                  '$.providerInstanceId',
                  ${routeSplit.nextInstanceId}
                )
              WHERE provider_instance_id = ${routeSplit.previousInstanceId}
                AND json_valid(runtime_payload_json)
                AND COALESCE(
                  json_extract(runtime_payload_json, '$.modelSelection.model'),
                  json_extract(runtime_payload_json, '$.model')
                ) = ${modelId}
            `;
            for (const selectionKey of ["defaultModelSelection", "modelSelection"]) {
              const instancePath = `$.${selectionKey}.instanceId`;
              const modelPath = `$.${selectionKey}.model`;
              yield* sql`
                UPDATE orchestration_events
                SET payload_json = json_set(
                  payload_json,
                  ${instancePath},
                  ${routeSplit.nextInstanceId}
                )
                WHERE json_valid(payload_json)
                  AND json_extract(payload_json, ${instancePath}) = ${routeSplit.previousInstanceId}
                  AND json_extract(payload_json, ${modelPath}) = ${modelId}
              `;
            }
            yield* sql`
              UPDATE orchestration_events
              SET payload_json = json_set(
                payload_json,
                '$.session.providerInstanceId',
                ${routeSplit.nextInstanceId}
              )
              WHERE json_valid(payload_json)
                AND json_extract(payload_json, '$.session.providerInstanceId') = ${routeSplit.previousInstanceId}
                AND json_extract(payload_json, '$.modelSelection.model') = ${modelId}
            `;

            yield* sql`
              INSERT INTO tritonai_managed_policy_migrations (migration_key, applied_at)
              VALUES (${migrationKey}, CURRENT_TIMESTAMP)
            `;
          }),
        );
      },
      { discard: true },
    );
  }
});

/** Replace retired managed on-prem models even when only the app is updated. */
export const migrateManagedModelReferences = Effect.fn("migrateManagedModelReferences")(function* (
  instanceId: string,
  replacements: Readonly<Record<string, string>>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const [previousModel, nextModel] of Object.entries(replacements)) {
        yield* sql`
          UPDATE provider_session_runtime
          SET runtime_payload_json = json_set(runtime_payload_json, '$.model', ${nextModel})
          WHERE (provider_instance_id = ${instanceId} OR (
            provider_instance_id IS NULL AND
            COALESCE(json_extract(runtime_payload_json, '$.providerInstanceId'),
              json_extract(runtime_payload_json, '$.modelSelection.instanceId'),
              json_extract(runtime_payload_json, '$.provider')) = ${instanceId}
          ))
            AND json_valid(runtime_payload_json)
            AND json_extract(runtime_payload_json, '$.model') = ${previousModel}
        `;
        for (const [table, column, selectionPath] of [
          ["projection_projects", "default_model_selection_json", "$"],
          ["projection_threads", "model_selection_json", "$"],
          ["provider_session_runtime", "runtime_payload_json", "$.modelSelection"],
          ["orchestration_events", "payload_json", "$.defaultModelSelection"],
          ["orchestration_events", "payload_json", "$.modelSelection"],
        ] as const) {
          const modelPath = `${selectionPath}.model`;
          const instancePath = `${selectionPath}.instanceId`;
          yield* sql`
          UPDATE ${sql(table)}
          SET ${sql(column)} = json_set(${sql(column)}, ${modelPath}, ${nextModel})
          WHERE json_valid(${sql(column)})
            AND (json_extract(${sql(column)}, ${instancePath}) = ${instanceId}
              OR (json_extract(${sql(column)}, ${instancePath}) IS NULL
                AND json_extract(${sql(column)}, ${`${selectionPath}.provider`}) = ${instanceId}))
            AND json_extract(${sql(column)}, ${modelPath}) = ${previousModel}
        `;
        }
      }
    }),
  );
});

/** Run the idempotent reference migration after settings and SQLite are ready. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.start;
    yield* migrateManagedModelReferences(
      managedConfig.provider.routes.onPrem.instanceId,
      Object.fromEntries(
        Object.entries(managedConfig.models.replacements).filter(([, target]) =>
          managedConfig.models.catalog.some(
            (model) => model.id === target && model.route === "on-prem",
          ),
        ),
      ),
    );
    yield* migrateManagedProviderInstanceReferences(getManagedProviderInstanceRenames(), {
      previousInstanceId: managedConfig.provider.routes.onPrem.instanceId,
      nextInstanceId: managedConfig.provider.routes.frontier.instanceId,
      frontierModelIds: managedConfig.models.catalog
        .filter((model) => model.route === managedConfig.provider.routes.frontier.id)
        .map((model) => model.id),
    });
  }),
);
