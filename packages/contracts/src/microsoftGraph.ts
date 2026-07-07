import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MicrosoftGraphClientId = "fcfe0e23-a675-4851-99a7-704dfd153b9c" as const;
export const MicrosoftGraphTenantId = "8a198873-4fec-4e76-8182-ca479edbbd60" as const;
export const MicrosoftGraphRequiredScopes = [
  "User.Read",
  "Mail.Read",
  "Calendars.Read",
  "offline_access",
] as const;

export const MicrosoftGraphConnectionState = Schema.Literals(["not_connected", "connected"]);
export type MicrosoftGraphConnectionState = typeof MicrosoftGraphConnectionState.Type;

export const MicrosoftGraphSignInPollState = Schema.Literals([
  "pending",
  "connected",
  "expired",
  "failed",
]);
export type MicrosoftGraphSignInPollState = typeof MicrosoftGraphSignInPollState.Type;

export const MicrosoftGraphAccount = Schema.Struct({
  id: Schema.NullOr(TrimmedNonEmptyString),
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  mail: Schema.NullOr(TrimmedNonEmptyString),
  userPrincipalName: Schema.NullOr(TrimmedNonEmptyString),
});
export type MicrosoftGraphAccount = typeof MicrosoftGraphAccount.Type;

export const MicrosoftGraphConnectionStatus = Schema.Struct({
  state: MicrosoftGraphConnectionState,
  account: Schema.NullOr(MicrosoftGraphAccount),
  clientId: Schema.Literal(MicrosoftGraphClientId),
  tenantId: Schema.Literal(MicrosoftGraphTenantId),
  requiredScopes: Schema.Array(TrimmedNonEmptyString),
  grantedScopes: Schema.Array(TrimmedNonEmptyString),
  accessTokenExpiresAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type MicrosoftGraphConnectionStatus = typeof MicrosoftGraphConnectionStatus.Type;

export const MicrosoftGraphStartSignInResult = Schema.Struct({
  flowId: TrimmedNonEmptyString,
  verificationUri: TrimmedNonEmptyString,
  verificationUriComplete: Schema.NullOr(TrimmedNonEmptyString),
  userCode: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
  intervalSeconds: PositiveInt,
  clientId: Schema.Literal(MicrosoftGraphClientId),
  tenantId: Schema.Literal(MicrosoftGraphTenantId),
  requiredScopes: Schema.Array(TrimmedNonEmptyString),
});
export type MicrosoftGraphStartSignInResult = typeof MicrosoftGraphStartSignInResult.Type;

export const MicrosoftGraphPollSignInInput = Schema.Struct({
  flowId: TrimmedNonEmptyString,
});
export type MicrosoftGraphPollSignInInput = typeof MicrosoftGraphPollSignInInput.Type;

export const MicrosoftGraphPollSignInResult = Schema.Struct({
  state: MicrosoftGraphSignInPollState,
  status: MicrosoftGraphConnectionStatus,
  retryAfterSeconds: Schema.NullOr(PositiveInt),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type MicrosoftGraphPollSignInResult = typeof MicrosoftGraphPollSignInResult.Type;

export const MicrosoftGraphDisconnectResult = Schema.Struct({
  status: MicrosoftGraphConnectionStatus,
});
export type MicrosoftGraphDisconnectResult = typeof MicrosoftGraphDisconnectResult.Type;

export class MicrosoftGraphConnectionError extends Schema.TaggedErrorClass<MicrosoftGraphConnectionError>()(
  "MicrosoftGraphConnectionError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "not_connected",
      "flow_not_found",
      "flow_expired",
      "oauth_error",
      "graph_error",
      "storage_error",
      "invalid_response",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
