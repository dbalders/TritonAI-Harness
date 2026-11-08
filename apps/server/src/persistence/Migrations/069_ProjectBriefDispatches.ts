import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_brief_dispatches (
    project_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    launch_json TEXT NOT NULL,
    PRIMARY KEY (project_id, command_id)
  ) WITHOUT ROWID`;
});
