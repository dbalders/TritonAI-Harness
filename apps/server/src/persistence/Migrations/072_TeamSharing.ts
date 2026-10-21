import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "team_sharing_off_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN team_sharing_off_at TEXT
    `;
  }
  if (!columns.some((column) => column.name === "team_sharing_resumed_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN team_sharing_resumed_at TEXT
    `;
  }
  yield* sql`DROP VIEW harness_activity_threads`;
  yield* sql`
    CREATE VIEW harness_activity_threads AS
    SELECT t.thread_id, t.project_id, t.title, t.created_at, t.updated_at,
      t.archived_at, t.deleted_at,
      json_extract(t.payload_json, '$.teamSharingOffAt') AS team_sharing_off_at,
      json_extract(t.payload_json, '$.teamSharingResumedAt') AS team_sharing_resumed_at,
      json_extract(t.payload_json, '$.branch') AS branch,
      json_extract(t.payload_json, '$.linkedPullRequest') AS linked_pull_request_json,
      json_extract(t.payload_json, '$.settledAt') AS settled_at,
      json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until,
      (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests r
        WHERE r.thread_id = t.thread_id AND r.status = 'pending') AS pending_approval_count,
      0 AS pending_user_input_count,
      COALESCE(
        (SELECT json_extract(pt.payload_json, '$.nativeThreadRef.nativeId')
          FROM orchestration_v2_projection_provider_threads pt
          WHERE pt.provider_thread_id = t.active_provider_thread_id AND pt.provider = 'codex'),
        (SELECT CASE WHEN json_valid(r.resume_cursor_json) THEN json_extract(r.resume_cursor_json, '$.threadId') END
          FROM provider_session_runtime r WHERE r.thread_id = t.thread_id AND r.provider_name = 'codex')
      ) AS codex_thread_id
    FROM orchestration_v2_projection_threads t
    UNION ALL
    SELECT t.thread_id, t.project_id, t.title, t.created_at, t.updated_at,
      t.archived_at, t.deleted_at, t.team_sharing_off_at, t.team_sharing_resumed_at,
      t.branch, t.linked_pull_request_json,
      t.settled_at, t.snoozed_until, t.pending_approval_count, t.pending_user_input_count,
      (SELECT CASE WHEN json_valid(r.resume_cursor_json) THEN json_extract(r.resume_cursor_json, '$.threadId') END
        FROM provider_session_runtime r WHERE r.thread_id = t.thread_id AND r.provider_name = 'codex') AS codex_thread_id
    FROM projection_threads t
    WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads v2 WHERE v2.thread_id = t.thread_id)
  `;
  yield* sql`CREATE TABLE IF NOT EXISTS teams_issued_references (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS teams_message_contexts (context_key TEXT PRIMARY KEY, message_id TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS teams_message_contexts_message_id ON teams_message_contexts(message_id)`;
});
