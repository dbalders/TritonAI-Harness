import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeAuth = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      auth_mode: Schema.optionalKey(
        Schema.NullOr(Schema.Literals(["apikey", "chatgpt", "chatgptAuthTokens"])),
      ),
      OPENAI_API_KEY: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
      tokens: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            id_token: Schema.NonEmptyString,
            access_token: Schema.NonEmptyString,
            account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
      last_refresh: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
    }),
  ),
);

/** Only the canonical credential owner may refresh; disposable Help never receives that grant. */
export function isolatedCodexHelpAuth(value: string): string | null {
  if (value.length > 256_000) return null;
  const auth = Option.getOrNull(decodeAuth(value));
  if (auth === null) return null;
  const mode = auth.auth_mode ?? (auth.OPENAI_API_KEY ? "apikey" : "chatgpt");
  if (mode === "apikey") {
    return auth.OPENAI_API_KEY
      ? JSON.stringify({ auth_mode: mode, OPENAI_API_KEY: auth.OPENAI_API_KEY })
      : null;
  }
  if (!auth.tokens || !auth.last_refresh || !Number.isFinite(Date.parse(auth.last_refresh)))
    return null;
  return JSON.stringify({
    auth_mode: mode,
    tokens: { ...auth.tokens, refresh_token: "" },
    last_refresh: auth.last_refresh,
  });
}
