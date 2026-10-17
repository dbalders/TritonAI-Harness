import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// V1 history stays lazy after cutover. Memory and Ideas must see it alongside
// V2 activity, with V2 authoritative for the same thread/message (including
// deletion), so importing or revisiting history cannot double-count it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE VIEW harness_activity_threads AS
    SELECT t.thread_id, t.project_id, t.title, t.created_at, t.updated_at,
      t.archived_at, t.deleted_at,
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
      t.archived_at, t.deleted_at, t.branch, t.linked_pull_request_json,
      t.settled_at, t.snoozed_until, t.pending_approval_count, t.pending_user_input_count,
      (SELECT CASE WHEN json_valid(r.resume_cursor_json) THEN json_extract(r.resume_cursor_json, '$.threadId') END
        FROM provider_session_runtime r WHERE r.thread_id = t.thread_id AND r.provider_name = 'codex') AS codex_thread_id
    FROM projection_threads t
    WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads v2 WHERE v2.thread_id = t.thread_id)
  `;
  yield* sql`
    CREATE VIEW harness_activity_messages AS
    SELECT m.message_id, m.thread_id, m.run_id AS turn_id, m.role,
      COALESCE(json_extract(m.payload_json, '$.text'), '') AS text,
      m.streaming AS is_streaming, m.created_at, m.updated_at
    FROM orchestration_v2_projection_messages m
    UNION ALL
    SELECT m.message_id, m.thread_id, m.turn_id, m.role, m.text, m.is_streaming, m.created_at, m.updated_at
    FROM projection_thread_messages m
    WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages v2 WHERE v2.message_id = m.message_id)
  `;
});
