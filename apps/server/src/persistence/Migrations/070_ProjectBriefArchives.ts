import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_brief_archives (
    project_id TEXT NOT NULL,
    archive_id TEXT NOT NULL,
    archived_at TEXT NOT NULL,
    state_json TEXT NOT NULL,
    PRIMARY KEY (project_id, archive_id)
  ) WITHOUT ROWID`;
});
