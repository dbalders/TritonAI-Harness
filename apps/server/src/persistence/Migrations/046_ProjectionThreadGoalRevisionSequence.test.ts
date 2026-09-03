import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ProjectionThreadGoalRevisionSequence", (it) => {
  it.effect("adds the goal revision sequence tie-breaker", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 45 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isFalse(before.some((column) => column.name === "goal_revision_sequence"));

      yield* runMigrations({ toMigrationInclusive: 46 });
      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(after.some((column) => column.name === "goal_revision_sequence"));
    }),
  );
});
