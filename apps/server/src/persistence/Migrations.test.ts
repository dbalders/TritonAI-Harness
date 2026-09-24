import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

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
  [47, "ClearAutomaticProjectModelDefaults"],
  [48, "ProjectionProjectsAutoPull"],
  [49, "RepairAutomaticSettlementTimestamps"],
  [50, "ProjectionProjectIcon"],
  [51, "ProjectionThreadBranchPullRequest"],
  [52, "ProjectionThreadsActiveOrderKey"],
  [53, "ProjectionThreadPullRequests"],
  [54, "ProjectionThreadMessageContext"],
  [55, "ProjectionThreadTitleState"],
];

it("keeps the migration registry unique and preserves shipped downstream identities", () => {
  const identities = migrationManifest.map(([id, name]) => [id, name] as const);
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
        migrationManifest.map(([id, name]) => [id, name]),
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

// Upgrade the database shape already shipped by Harness before appending upstream IDs.
it.layer(NodeSqliteClient.layerMemory())("migration upgrade from shipped Harness 046", (it) => {
  it.effect("preserves goals, messages and project choices while backfilling pull requests", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      const timestamp = "2026-09-22T12:00:00.000Z";
      const model = '{"instanceId":"codex","model":"managed-model"}';
      const goal = '{"objective":"Preserve downstream work","status":"active","tokenBudget":1000}';
      const linked =
        '{"repository":"Citizen-Developer/Harness","number":271,"url":"https://github.com/Citizen-Developer/Harness/pull/271"}';
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, default_model_selection_json) VALUES ('project-upgrade', 'Preserved project', '/workspace/project', '[]', ${timestamp}, ${timestamp}, ${model})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, goal_json, goal_revision_at, goal_revision_sequence, linked_pull_request_json) VALUES ('thread-upgrade', 'project-upgrade', 'Preserved thread', ${model}, ${timestamp}, ${timestamp}, ${goal}, ${timestamp}, 42, ${linked})`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES ('message-upgrade', 'thread-upgrade', 'user', 'Keep the history', 0, ${timestamp}, ${timestamp})`;
      const applied = yield* runMigrations();
      assert.deepStrictEqual(
        applied,
        POST_032_MIGRATION_IDENTITIES.filter(([id]) => id > 46),
      );
      const threads =
        yield* sql`SELECT goal_json, goal_revision_at, goal_revision_sequence, model_selection_json, title FROM projection_threads WHERE thread_id = 'thread-upgrade'`;
      assert.deepStrictEqual(threads, [
        {
          goal_json: goal,
          goal_revision_at: timestamp,
          goal_revision_sequence: 42,
          model_selection_json: model,
          title: "Preserved thread",
        },
      ]);
      const projects =
        yield* sql`SELECT default_model_selection_json FROM projection_projects WHERE project_id = 'project-upgrade'`;
      assert.deepStrictEqual(projects, [{ default_model_selection_json: model }]);
      const messages =
        yield* sql`SELECT text, context_json FROM projection_thread_messages WHERE message_id = 'message-upgrade'`;
      assert.deepStrictEqual(messages, [{ text: "Keep the history", context_json: null }]);
      const links =
        yield* sql`SELECT repository, number, url FROM projection_thread_pull_requests WHERE thread_id = 'thread-upgrade'`;
      assert.deepStrictEqual(links, [
        {
          repository: "citizen-developer/harness",
          number: 271,
          url: "https://github.com/Citizen-Developer/Harness/pull/271",
        },
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});
