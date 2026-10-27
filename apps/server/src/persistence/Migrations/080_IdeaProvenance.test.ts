import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ExternalContentSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "fences historical assistant content without widening recorded scopes or marking fresh user-only work",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      const at = "2026-10-01T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/fixture', '[]', ${at}, ${at})`;
      for (const id of ["legacy", "recorded", "user-only"]) {
        yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, created_at, updated_at)
        VALUES (${id}, 'project', ${id}, ${at}, ${at})`;
        yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${id}, ${id}, ${id === "user-only" ? "user" : "assistant"}, 'History', 0, ${at}, ${at})`;
      }
      yield* sql`INSERT INTO external_content_scopes
      (owner_id, scope_id, scope_version, exposure_version, provider_session_id,
        provider_instance_id, boundary_digest, allowed_tools_json)
      VALUES ('thread:recorded', 'recorded-scope', 1, 0, 'session', 'provider', ${"a".repeat(64)}, '["fixture.read"]')`;
      yield* runMigrations();
      const rows = yield* sql<{
        owner_id: string;
        exposure_version: number;
        allowed_tools_json: string;
      }>`
      SELECT owner_id, exposure_version, allowed_tools_json FROM external_content_scopes ORDER BY owner_id`;
      expect(rows).toEqual([
        { owner_id: "thread:legacy", exposure_version: 1, allowed_tools_json: "[]" },
        {
          owner_id: "thread:recorded",
          exposure_version: 0,
          allowed_tools_json: '["fixture.read"]',
        },
      ]);
      const [receipt] = yield* sql<{ source_json: string }>`
      SELECT source_json FROM external_content_exposures WHERE owner_id = 'thread:legacy'`;
      expect(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExternalContentSource))(
          receipt!.source_json,
        ),
      ).toEqual({ kind: "derived", artifactKind: "legacy-history", artifactId: "legacy" });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
