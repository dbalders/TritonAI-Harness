import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE external_content_scopes (
    owner_id TEXT PRIMARY KEY NOT NULL,
    scope_id TEXT NOT NULL UNIQUE,
    scope_version INTEGER NOT NULL CHECK (scope_version > 0),
    exposure_version INTEGER NOT NULL DEFAULT 0 CHECK (exposure_version >= 0),
    provider_session_id TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    boundary_digest TEXT NOT NULL,
    allowed_tools_json TEXT NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE external_content_exposures (
    invocation_id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES external_content_scopes(owner_id),
    scope_id TEXT NOT NULL,
    exposure_version INTEGER NOT NULL CHECK (exposure_version > 0),
    source_json TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    UNIQUE (owner_id, exposure_version)
  ) WITHOUT ROWID`;
});
