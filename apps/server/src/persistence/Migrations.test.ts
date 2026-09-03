import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const POST_032_MIGRATION_IDENTITIES: Array<readonly [number, string]> = [
  [33, "BackfillProjectionThreadSessionInstanceId"],
  [34, "ProjectionThreadsSettled"],
  [35, "ProjectionThreadsSnoozed"],
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionTurnsKeysetIndex"],
  [38, "ProjectionThreadsPinOrderKey"],
  [39, "ProjectionProjectsDefaultThreadEnvMode"],
  [40, "ProjectionProjectFaviconPath"],
  [41, "ProjectionThreadTitleRegeneration"],
  [42, "AuthSessionClientConnection"],
  [43, "ProjectionThreadLinkedPullRequest"],
  [44, "ProjectionThreadsUnsettledAt"],
  [45, "ProjectionThreadGoals"],
  [46, "ProjectionThreadGoalRevisionSequence"],
];

it("keeps the migration registry unique and preserves shipped downstream identities", () => {
  const identities = migrationEntries.map(([id, name]) => [id, name] as const);
  const ids = identities.map(([id]) => id);

  assert.deepStrictEqual(
    ids,
    [...ids].sort((left, right) => left - right),
  );
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.deepStrictEqual(identities.slice(32), POST_032_MIGRATION_IDENTITIES);
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
        recorded
          .filter(({ migration_id }) => migration_id >= 33)
          .map(({ migration_id, name }) => [migration_id, name] as const),
        POST_032_MIGRATION_IDENTITIES,
      );

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.deepStrictEqual(
        columns
          .map(({ name }) => name)
          .filter((name) =>
            [
              "settled_override",
              "settled_at",
              "snoozed_until",
              "snoozed_at",
              "unsettled_at",
            ].includes(name),
          ),
        ["settled_override", "settled_at", "snoozed_until", "snoozed_at", "unsettled_at"],
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
      assert.deepStrictEqual(executed, POST_032_MIGRATION_IDENTITIES.slice(1));

      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 33
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        recorded.map(({ migration_id, name }) => [migration_id, name] as const),
        POST_032_MIGRATION_IDENTITIES,
      );

      const upgradedColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.deepStrictEqual(
        upgradedColumns
          .map(({ name }) => name)
          .filter((name) =>
            [
              "settled_override",
              "settled_at",
              "snoozed_until",
              "snoozed_at",
              "unsettled_at",
            ].includes(name),
          ),
        ["settled_override", "settled_at", "snoozed_until", "snoozed_at", "unsettled_at"],
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
      assert.deepStrictEqual(executed, POST_032_MIGRATION_IDENTITIES.slice(2));

      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 34
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        recorded.map(({ migration_id, name }) => [migration_id, name] as const),
        POST_032_MIGRATION_IDENTITIES.slice(1),
      );

      const upgradedColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.deepStrictEqual(
        upgradedColumns
          .map(({ name }) => name)
          .filter((name) =>
            [
              "settled_override",
              "settled_at",
              "snoozed_until",
              "snoozed_at",
              "unsettled_at",
            ].includes(name),
          ),
        ["settled_override", "settled_at", "snoozed_until", "snoozed_at", "unsettled_at"],
      );
    }),
  );
});
