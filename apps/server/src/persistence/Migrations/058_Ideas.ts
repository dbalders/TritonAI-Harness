import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // idea_key preserves feedback across rewording; previous_status supports undo.
  // content_json stores the card; draft_thread_ids_json tracks each client’s sent draft.
  // opened_message_ids_json detects new sends without clocks, even after thread reverts.
  yield* sql`
    CREATE TABLE IF NOT EXISTS ideas (
      idea_id TEXT PRIMARY KEY,
      idea_key TEXT NOT NULL,
      section TEXT NOT NULL,
      content_json TEXT NOT NULL,
      status TEXT NOT NULL,
      previous_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      opened_at TEXT,
      draft_thread_ids_json TEXT,
      opened_message_ids_json TEXT,
      snoozed_until TEXT,
      hidden_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_ideas_key ON ideas(idea_key)`;

  // One row per press, so the mix of sections can follow what the user responds to.
  yield* sql`
    CREATE TABLE IF NOT EXISTS idea_feedback (
      idea_id TEXT NOT NULL,
      section TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_idea_feedback_created ON idea_feedback(created_at)`;

  // Small generator state: when the page was last viewed, when ideas were last generated, and the
  // day's model call count.
  yield* sql`
    CREATE TABLE IF NOT EXISTS idea_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `;

  // When each skill or plugin was first seen, so "New in TritonAI" means new to this user.
  yield* sql`
    CREATE TABLE IF NOT EXISTS idea_catalog_seen (
      entry_id TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
