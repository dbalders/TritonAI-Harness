import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it("keeps the migration registry unique and preserves the 033-035 identities", () => {
  const identities = migrationEntries.map(([id, name]) => [id, name] as const);
  const ids = identities.map(([id]) => id);

  assert.deepStrictEqual(
    ids,
    [...ids].sort((left, right) => left - right),
  );
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.deepStrictEqual(identities.slice(-3), [
    [33, "BackfillProjectionThreadSessionInstanceId"],
    [34, "ProjectionThreadsSettled"],
    [35, "ProjectionThreadsSnoozed"],
  ]);
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("clean migration install", (it) => {
  it.effect("executes every registered import under its declared identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;

      assert.deepStrictEqual(
        recorded.map(({ migration_id, name }) => [migration_id, name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );
      assert.deepStrictEqual(
        recorded.filter(({ migration_id }) => migration_id >= 33),
        [
          {
            migration_id: 33,
            name: "BackfillProjectionThreadSessionInstanceId",
          },
          {
            migration_id: 34,
            name: "ProjectionThreadsSettled",
          },
          {
            migration_id: 35,
            name: "ProjectionThreadsSnoozed",
          },
        ],
      );

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.deepStrictEqual(
        columns
          .map(({ name }) => name)
          .filter((name) =>
            ["settled_override", "settled_at", "snoozed_until", "snoozed_at"].includes(name),
          ),
        ["settled_override", "settled_at", "snoozed_until", "snoozed_at"],
      );
    }),
  );
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("migration upgrade from 033", (it) => {
  it.effect("retains the backfill identity and appends settled then snoozed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 33 });

      const columnsAt33 = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(
        columnsAt33.some(({ name }) => name === "settled_override"),
        false,
      );
      assert.strictEqual(
        columnsAt33.some(({ name }) => name === "snoozed_until"),
        false,
      );

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [34, "ProjectionThreadsSettled"],
        [35, "ProjectionThreadsSnoozed"],
      ]);

      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 33
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(recorded, [
        {
          migration_id: 33,
          name: "BackfillProjectionThreadSessionInstanceId",
        },
        {
          migration_id: 34,
          name: "ProjectionThreadsSettled",
        },
        {
          migration_id: 35,
          name: "ProjectionThreadsSnoozed",
        },
      ]);

      const upgradedColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.deepStrictEqual(
        upgradedColumns
          .map(({ name }) => name)
          .filter((name) =>
            ["settled_override", "settled_at", "snoozed_until", "snoozed_at"].includes(name),
          ),
        ["settled_override", "settled_at", "snoozed_until", "snoozed_at"],
      );
    }),
  );
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("migration upgrade from 034", (it) => {
  it.effect("retains settled and appends snoozed as migration 035", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });

      const columnsAt34 = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.strictEqual(
        columnsAt34.some(({ name }) => name === "settled_override"),
        true,
      );
      assert.strictEqual(
        columnsAt34.some(({ name }) => name === "settled_at"),
        true,
      );
      assert.strictEqual(
        columnsAt34.some(({ name }) => name === "snoozed_until"),
        false,
      );
      assert.strictEqual(
        columnsAt34.some(({ name }) => name === "snoozed_at"),
        false,
      );

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [[35, "ProjectionThreadsSnoozed"]]);

      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id IN (34, 35)
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(recorded, [
        {
          migration_id: 34,
          name: "ProjectionThreadsSettled",
        },
        {
          migration_id: 35,
          name: "ProjectionThreadsSnoozed",
        },
      ]);

      const upgradedColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.deepStrictEqual(
        upgradedColumns
          .map(({ name }) => name)
          .filter((name) =>
            ["settled_override", "settled_at", "snoozed_until", "snoozed_at"].includes(name),
          ),
        ["settled_override", "settled_at", "snoozed_until", "snoozed_at"],
      );
    }),
  );
});
