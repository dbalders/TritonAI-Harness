import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateTeamSharing from "./072_TeamSharing.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("072_TeamSharing", (it) => {
  it.effect("adds the column with existing threads shared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
      yield* runMigrations();
      const read = sql<{
        readonly teamSharingOffAt: string | null;
        readonly teamSharingResumedAt: string | null;
      }>`
        SELECT team_sharing_off_at AS "teamSharingOffAt", team_sharing_resumed_at AS "teamSharingResumedAt"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(yield* read, [{ teamSharingOffAt: null, teamSharingResumedAt: null }]);
      // Re-running against a database that already has the column keeps its value.
      yield* sql`UPDATE projection_threads SET team_sharing_off_at = ${now} WHERE thread_id = 'thread-1'`;
      yield* migrateTeamSharing;
      assert.deepEqual(yield* read, [{ teamSharingOffAt: now, teamSharingResumedAt: null }]);
    }),
  );
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("Teams preview upgrade", (it) => {
  it.effect("upgrades the earlier Teams preview without losing sharing choices or references", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      yield* migrateTeamSharing;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (72, 'TeamSharing')`;
      const now = "2026-10-22T12:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at, team_sharing_off_at
        ) VALUES (
          'preview-thread', 'preview-project', 'Private preview work',
          '{"instanceId":"codex","model":"test-model"}', 'full-access', ${now}, ${now}, ${now}
        )
      `;
      yield* sql`INSERT INTO teams_issued_references (id, payload_json) VALUES ('retained-reference', '{"source":"preview"}')`;
      assert.deepEqual(yield* runMigrations(), [
        [72, "ProjectNextStepDismissals"],
        [73, "DropUnusedV1Projections"],
        [74, "CanonicalizeThreadPullRequestLinks"],
        [75, "CodexUsageNativeTurnIndex"],
        [76, "RepairClientSettlementTimestamps"],
        [77, "WebhookDedupe"],
        [78, "TeamSharing"],
      ]);
      assert.deepEqual(
        yield* sql`SELECT team_sharing_off_at FROM projection_threads WHERE thread_id = 'preview-thread'`,
        [{ team_sharing_off_at: now }],
      );
      assert.deepEqual(yield* sql`SELECT id FROM teams_issued_references`, [
        { id: "retained-reference" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_next_step_dismissals'`,
        [{ name: "project_next_step_dismissals" }],
      );
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "Teams preview invalid history",
  (it) => {
    it.effect("keeps the exact preview ledger when validation rejects an upgrade", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 71 });
        yield* migrateTeamSharing;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (72, 'TeamSharing')`;
        yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownFork' WHERE migration_id = 70`;
        const history = sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        const before = yield* history;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepEqual(yield* history, before);
      }),
    );
  },
);

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "Teams preview migration failure",
  (it) => {
    it.effect("rolls reconciliation back when a later migration cannot run", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 71 });
        yield* migrateTeamSharing;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (72, 'TeamSharing')`;
        yield* sql`CREATE TABLE project_next_step_dismissals (unexpected TEXT)`;
        const history = sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        const before = yield* history;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepEqual(yield* history, before);
        // Correct the external conflict and retry the same preserved preview.
        yield* sql`DROP TABLE project_next_step_dismissals`;
        assert.equal((yield* runMigrations()).at(-1)?.[0], 78);
        assert.deepEqual(yield* runMigrations(), []);
      }),
    );
  },
);
