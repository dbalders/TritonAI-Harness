import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Ideas from "./Migrations/058_Ideas.ts";

// Earlier Harness V2 candidates used 56, then 57. Preserve their schema and
// import progress while keeping the released Harness migration identities.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 33
      `;
      const legacy = history.find((row) => row.name === "OrchestrationV2" && row.migration_id < 59);
      if (!legacy) return [];
      const valid =
        (legacy.migration_id === 56 || legacy.migration_id === 57) &&
        history.some(
          (row) =>
            row.migration_id === 33 && row.name === "BackfillProjectionThreadSessionInstanceId",
        ) &&
        history
          .filter((row) => row.migration_id >= 56)
          .every(
            (row) =>
              row === legacy ||
              (legacy.migration_id === 57 &&
                ((row.migration_id === 56 && row.name === "PullRequestFilesViewed") ||
                  (row.migration_id === 58 && row.name === "RemoveRedundantProjectionIndexes"))),
          );
      if (!valid) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            "Cannot upgrade this V2 preview: its migration history does not match a Harness preview.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (legacy.migration_id === 56) {
        yield* PullRequestFilesViewed;
        executed.push([56, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([57, "ProjectionThreadsAutoSettleDisabledAt"]);
      yield* Ideas;
      executed.push([58, "Ideas"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 60 WHERE migration_id = 58 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 59 WHERE migration_id = ${legacy.migration_id} AND name = 'OrchestrationV2'`;
      if (legacy.migration_id === 56) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (56, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (57, 'ProjectionThreadsAutoSettleDisabledAt'), (58, 'Ideas')`;
      return executed;
    }),
  );
});
