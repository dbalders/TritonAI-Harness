import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE external_content_exposures ADD COLUMN origin_invocation_id TEXT`;
  yield* sql`UPDATE external_content_exposures SET origin_invocation_id = invocation_id`;
  yield* sql`CREATE UNIQUE INDEX external_content_origin ON external_content_exposures (owner_id, origin_invocation_id)`;
  yield* sql`CREATE TABLE external_content_inheritance (
    source_owner_id TEXT NOT NULL,
    target_owner_id TEXT NOT NULL,
    source_exposure_version INTEGER NOT NULL CHECK (source_exposure_version > 0),
    source_tools_json TEXT NOT NULL,
    PRIMARY KEY (source_owner_id, target_owner_id)
  ) WITHOUT ROWID`;
});
