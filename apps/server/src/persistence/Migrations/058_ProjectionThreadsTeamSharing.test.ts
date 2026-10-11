import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateTeamSharing from "./058_ProjectionThreadsTeamSharing.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "058_ProjectionThreadsTeamSharing",
  (it) => {
    it.effect("adds the column with existing threads shared", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 57 });
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
        yield* runMigrations({ toMigrationInclusive: 58 });
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
  },
);
