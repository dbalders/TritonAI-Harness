import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Auxiliary models may summarize accepted conversation history, but must not become
 * another delivery route for a held Teams prompt. `m` is a harness_activity_messages
 * row. A root-run acceptance only covers its own user message: protected steering
 * text without individual acceptance evidence stays excluded.
 */
export const auxiliaryMessageCondition = (sql: SqlClient.SqlClient) => sql`(
  m.role <> 'user'
  OR NOT EXISTS (
    SELECT 1 FROM teams_message_contexts context WHERE context.message_id = m.message_id
  )
  OR EXISTS (
    SELECT 1 FROM orchestration_v2_projection_runs run
    JOIN orchestration_v2_projection_run_attempts attempt
      ON attempt.run_id = run.run_id AND attempt.thread_id = run.thread_id
    JOIN orchestration_v2_projection_provider_turns provider_turn
      ON provider_turn.run_attempt_id = attempt.attempt_id AND provider_turn.thread_id = run.thread_id
    WHERE run.run_id = m.turn_id AND run.thread_id = m.thread_id
      AND json_extract(run.payload_json, '$.userMessageId') = m.message_id
      AND (provider_turn.started_at IS NOT NULL
        OR json_extract(provider_turn.payload_json, '$.nativeTurnRef.nativeId') IS NOT NULL)
  )
)`;
