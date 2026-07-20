import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

it("keeps the migration registry unique, ordered, and anchored by downstream migration 033", () => {
  const identities = migrationEntries.map(([id, name]) => [id, name] as const);
  const ids = identities.map(([id]) => id);

  assert.deepStrictEqual(
    ids,
    [...ids].sort((left, right) => left - right),
  );
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.deepStrictEqual(
    identities.find(([id]) => id === 33),
    [33, "BackfillProjectionThreadSessionInstanceId"],
  );
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("migration imports", (it) => {
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
        recorded.find(({ migration_id }) => migration_id === 33),
        {
          migration_id: 33,
          name: "BackfillProjectionThreadSessionInstanceId",
        },
      );
    }),
  );
});
