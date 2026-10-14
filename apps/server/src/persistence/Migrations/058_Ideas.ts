import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Every idea ever shown stays as a row: its `idea_key` names what it is about, so a dismissed,
  // rejected, or used idea is not suggested again even when the model words it differently.
  // `content_json` holds the card (icon, title, body, sources, action). `previous_status` is what
  // an undo restores. `draft_thread_ids_json` lists the threads a new-thread idea's drafts become
  // when sent, one per client that opened it. `opened_message_count` is how many messages a
  // continue-in-thread idea's thread had when first opened, so a send is seen without comparing
  // clocks.
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
      opened_message_count INTEGER,
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
