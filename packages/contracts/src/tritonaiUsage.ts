import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A server-sanitized snapshot of the currently configured TritonAI key.
 *
 * This intentionally excludes the provider response's raw key and internal
 * user, team, project, and organization identifiers.
 */
export const ServerTritonAiUsageSnapshot = Schema.Struct({
  keyName: Schema.NullOr(TrimmedNonEmptyString),
  keyAlias: Schema.NullOr(TrimmedNonEmptyString),
  spend: NonNegativeFinite,
  maxBudget: Schema.NullOr(NonNegativeFinite),
  budgetDuration: Schema.NullOr(TrimmedNonEmptyString),
  budgetResetAt: Schema.NullOr(IsoDateTime),
  models: Schema.Array(TrimmedNonEmptyString),
  tpmLimit: Schema.NullOr(NonNegativeInt),
  rpmLimit: Schema.NullOr(NonNegativeInt),
  maxParallelRequests: Schema.NullOr(NonNegativeInt),
  expiresAt: Schema.NullOr(IsoDateTime),
  lastActiveAt: Schema.NullOr(IsoDateTime),
  softBudgetCooldown: Schema.NullOr(Schema.Boolean),
  blocked: Schema.NullOr(Schema.Boolean),
  fetchedAt: IsoDateTime,
});
export type ServerTritonAiUsageSnapshot = typeof ServerTritonAiUsageSnapshot.Type;

export const ServerTritonAiUsageErrorCode = Schema.Literals([
  "missing_api_key",
  "invalid_base_url",
  "upstream_timeout",
  "upstream_unavailable",
  "key_rejected",
  "upstream_rate_limited",
  "upstream_error",
  "invalid_response",
]);
export type ServerTritonAiUsageErrorCode = typeof ServerTritonAiUsageErrorCode.Type;

export class ServerTritonAiUsageError extends Schema.TaggedErrorClass<ServerTritonAiUsageError>()(
  "ServerTritonAiUsageError",
  {
    code: ServerTritonAiUsageErrorCode,
    message: TrimmedNonEmptyString,
    recoverable: Schema.Boolean,
    status: Schema.optionalKey(Schema.Number),
  },
) {}
