import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./persistence/Migrations.ts";
import { seedV2Activity } from "./persistence/HarnessActivity.testkit.ts";
import { AnalyticsService } from "./telemetry/AnalyticsService.ts";
import { recordStartupHeartbeat } from "./serverRuntimeStartup.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("startup heartbeat", (it) => {
  it.effect(
    "counts authoritative V2 activity and lazy V1 history with anonymous month-only metadata",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project', 'PRIVATE_PROJECT', '/PRIVATE_PATH', '[]', '2026-01-01', '2026-01-01')`;
        for (const [id, at] of [
          ["legacy", "2026-04-01"],
          ["migrated", "2026-01-01"],
          ["deleted", "2025-12-01"],
        ]) {
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at) VALUES (${id}, 'project', 'PRIVATE_TITLE', ${at}, ${at})`;
        }
        yield* seedV2Activity({
          threadId: "new",
          projectId: "project",
          title: "PRIVATE_TITLE",
          at: "2026-02-01",
          messages: [],
        });
        yield* seedV2Activity({
          threadId: "migrated",
          projectId: "project",
          title: "PRIVATE_TITLE",
          at: "2026-03-01",
          messages: [],
        });
        yield* seedV2Activity({
          threadId: "deleted",
          projectId: "project",
          title: "PRIVATE_TITLE",
          at: "2026-03-01",
          deletedAt: "2026-03-02",
          messages: [],
        });
        const recorded: Array<{
          event: string;
          properties: Readonly<Record<string, unknown>> | undefined;
        }> = [];
        yield* recordStartupHeartbeat.pipe(
          Effect.provide(
            Layer.succeed(
              AnalyticsService,
              AnalyticsService.of({
                record: (event, properties) =>
                  Effect.sync(() => {
                    recorded.push({ event, properties });
                  }),
                flush: Effect.void,
              }),
            ),
          ),
        );
        assert.deepStrictEqual(recorded, [
          {
            event: "server.boot.heartbeat",
            properties: { threadCount: 3, projectCount: 1, firstThreadMonth: "2026-02" },
          },
        ]);
      }),
  );
});
