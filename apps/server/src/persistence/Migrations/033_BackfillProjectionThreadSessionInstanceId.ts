import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Backfills the canonical legacy instance id only when `provider_name` is a
 * valid provider slug. Before provider instances were introduced, the driver
 * name was also the canonical single-instance routing key. Malformed legacy
 * values cannot be mapped safely and remain null for the compatibility layer.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_instance_id = provider_name
    WHERE provider_instance_id IS NULL
      AND provider_name IS NOT NULL
      AND length(provider_name) BETWEEN 1 AND 64
      AND provider_name GLOB '[A-Za-z]*'
      AND provider_name NOT GLOB '*[^A-Za-z0-9_-]*'
  `;
});
