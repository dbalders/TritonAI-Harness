import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_briefs (
    project_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    state_json TEXT NOT NULL
  ) WITHOUT ROWID`;
  // A request id is scoped to a project and exact canonical payload. State and
  // receipt commit together, before any thread dispatch leaves the service.
  yield* sql`CREATE TABLE project_brief_requests (
    project_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    PRIMARY KEY (project_id, request_id)
  ) WITHOUT ROWID`;
});
