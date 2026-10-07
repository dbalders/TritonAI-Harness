import * as Schema from "effect/Schema";

const AccountText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));

export const AccountProfile = Schema.Struct({
  issuer: AccountText,
  subject: AccountText,
  email: Schema.String.check(Schema.isMaxLength(320)),
  displayName: Schema.String.check(Schema.isMaxLength(320)),
});
export type AccountProfile = typeof AccountProfile.Type;

/** Public state for this authenticated environment session; never includes credentials. */
export const AccountStatus = Schema.Struct({
  configured: Schema.Boolean,
  status: Schema.Literals(["signed-out", "pending", "signed-in"]),
  serviceUrl: Schema.NullOr(Schema.String),
  profile: Schema.NullOr(AccountProfile),
  expiresAt: Schema.NullOr(Schema.Int),
  verificationUrl: Schema.NullOr(Schema.String),
  userCode: Schema.NullOr(Schema.String),
  pollIntervalSeconds: Schema.NullOr(Schema.Int),
  returnUrl: Schema.optionalKey(Schema.String),
});
export type AccountStatus = typeof AccountStatus.Type;

export class ServerAccountError extends Schema.TaggedError<ServerAccountError>()(
  "ServerAccountError",
  {
    code: Schema.Literals([
      "not_configured",
      "invalid_configuration",
      "unavailable",
      "invalid_response",
      "login_expired",
      "storage_error",
      "request_rejected",
    ]),
    message: Schema.String,
  },
) {}
