import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE ideas ADD COLUMN provenance_recorded INTEGER NOT NULL DEFAULT 0`;
  // Existing transcripts predate the host's exposure ledger. Absence of a receipt cannot
  // certify that their assistant text never contained an integration result.
  yield* sql`INSERT INTO external_content_scopes
    (owner_id, scope_id, scope_version, exposure_version, provider_session_id,
      provider_instance_id, boundary_digest, allowed_tools_json)
    SELECT 'thread:' || t.thread_id, lower(hex(randomblob(16))), 1, 1,
      'unverified', 'unverified', ${"0".repeat(64)}, '[]'
    FROM harness_activity_threads t
    WHERE EXISTS (SELECT 1 FROM harness_activity_messages m
      WHERE m.thread_id = t.thread_id AND m.role = 'assistant')
      AND NOT EXISTS (SELECT 1 FROM external_content_scopes s
        WHERE s.owner_id = 'thread:' || t.thread_id)`;
  yield* sql`INSERT INTO external_content_exposures
    (invocation_id, owner_id, scope_id, exposure_version, source_json, received_at, origin_invocation_id)
    SELECT 'legacy:' || s.scope_id, s.owner_id, s.scope_id, 1,
      json_object('kind', 'derived', 'artifactKind', 'legacy-history',
        'artifactId', substr(s.owner_id, 8)), 0, 'legacy:' || s.scope_id
    FROM external_content_scopes s WHERE s.provider_instance_id = 'unverified'
      AND s.exposure_version = 1 AND s.owner_id LIKE 'thread:%'
      AND NOT EXISTS (SELECT 1 FROM external_content_exposures e WHERE e.owner_id = s.owner_id)`;
});
