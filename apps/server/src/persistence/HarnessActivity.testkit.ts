import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Projection rows for the V1/V2 activity-reader boundary, without starting provider work. */
export const seedV2Activity = Effect.fn(function* (input: {
  threadId: string;
  projectId: string;
  title: string;
  at: string;
  deletedAt?: string;
  messages: ReadonlyArray<{
    id: string;
    role: "user" | "assistant";
    text: string;
    streaming?: boolean;
  }>;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, deleted_at, payload_json)
    VALUES (${input.threadId}, ${input.projectId}, ${input.title}, 'codex', 'approval-required', 'default', ${input.at}, ${input.at}, ${input.deletedAt ?? null}, '{}')
  `;
  for (const message of input.messages) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${message.id}, ${input.threadId}, ${message.role}, ${message.streaming ? 1 : 0}, ${input.at}, ${input.at}, json_object('text', ${message.text}))
    `;
  }
});
