import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_overviews (
    project_id TEXT PRIMARY KEY NOT NULL,
    workspace_root TEXT NOT NULL,
    overview_json TEXT NOT NULL
  ) WITHOUT ROWID`;
});
