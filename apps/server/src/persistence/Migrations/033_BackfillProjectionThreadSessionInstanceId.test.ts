import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import BackfillProjectionThreadSessionInstanceId from "./033_BackfillProjectionThreadSessionInstanceId.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertLegacySessions = (suffix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const legacyThreadId = `thread-legacy-${suffix}`;
    const ambiguousThreadId = `thread-ambiguous-${suffix}`;

    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_session_id,
        provider_thread_id,
        runtime_mode,
        active_turn_id,
        last_error,
        updated_at
      )
      VALUES (
        ${legacyThreadId},
        'running',
        'codex',
        ${`provider-session-legacy-${suffix}`},
        ${`provider-thread-legacy-${suffix}`},
        'approval-required',
        ${`turn-legacy-${suffix}`},
        NULL,
        '2026-06-01T00:00:00.000Z'
      ),
      (
        ${ambiguousThreadId},
        'running',
        'OpenAI/Codex',
        ${`provider-session-ambiguous-${suffix}`},
        ${`provider-thread-ambiguous-${suffix}`},
        'approval-required',
        ${`turn-ambiguous-${suffix}`},
        NULL,
        '2026-06-01T00:00:00.000Z'
      )
    `;

    return { ambiguousThreadId, legacyThreadId } as const;
  });

layer("033_BackfillProjectionThreadSessionInstanceId", (it) => {
  it.effect("upgrades an installation that already recorded migration 028", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 26 });
      const { ambiguousThreadId, legacyThreadId } = yield* insertLegacySessions("upgrade");
      yield* runMigrations({ toMigrationInclusive: 28 });

      const beforeBackfill = yield* sql<{
        readonly provider_instance_id: string | null;
      }>`
        SELECT provider_instance_id
        FROM projection_thread_sessions
        WHERE thread_id = ${legacyThreadId}
      `;
      assert.deepStrictEqual(beforeBackfill, [{ provider_instance_id: null }]);

      yield* runMigrations({ toMigrationInclusive: 33 });

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id IN (28, 33)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 28,
          name: "ProjectionThreadSessionInstanceId",
        },
        {
          migration_id: 33,
          name: "BackfillProjectionThreadSessionInstanceId",
        },
      ]);

      const sessions = yield* sql<{
        readonly thread_id: string;
        readonly provider_instance_id: string | null;
      }>`
        SELECT thread_id, provider_instance_id
        FROM projection_thread_sessions
        WHERE thread_id = ${ambiguousThreadId}
          OR thread_id = ${legacyThreadId}
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(sessions, [
        {
          thread_id: ambiguousThreadId,
          provider_instance_id: null,
        },
        {
          thread_id: legacyThreadId,
          provider_instance_id: "codex",
        },
      ]);
    }),
  );

  it.effect("runs on a fresh installation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id = 33
      `;
      assert.deepStrictEqual(migrations, [
        {
          migration_id: 33,
          name: "BackfillProjectionThreadSessionInstanceId",
        },
      ]);
    }),
  );

  it.effect("is idempotent and leaves ambiguous or existing values untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 28 });
      const { ambiguousThreadId, legacyThreadId } = yield* insertLegacySessions("reexecution");
      yield* sql`
        UPDATE projection_thread_sessions
        SET provider_instance_id = 'codex_work'
        WHERE thread_id = ${legacyThreadId}
      `;

      yield* BackfillProjectionThreadSessionInstanceId;
      yield* BackfillProjectionThreadSessionInstanceId;

      const sessions = yield* sql<{
        readonly thread_id: string;
        readonly provider_instance_id: string | null;
      }>`
        SELECT thread_id, provider_instance_id
        FROM projection_thread_sessions
        WHERE thread_id = ${ambiguousThreadId}
          OR thread_id = ${legacyThreadId}
        ORDER BY thread_id
      `;
      assert.deepStrictEqual(sessions, [
        {
          thread_id: ambiguousThreadId,
          provider_instance_id: null,
        },
        {
          thread_id: legacyThreadId,
          provider_instance_id: "codex_work",
        },
      ]);
    }),
  );
});
