import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_next_step_dismissals (
    project_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, step_id)
  ) WITHOUT ROWID`;
});
