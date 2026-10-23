import { describe, expect, it } from "vite-plus/test";
import { isolatedCodexHelpAuth } from "./CodexHelpAuth.ts";

const tokens = {
  id_token: "synthetic-id-token",
  access_token: "synthetic-access-token",
  refresh_token: "synthetic-refresh-must-stay-with-owner",
  account_id: "synthetic-account",
  private_extension: "private-extra-token-metadata",
};
const lastRefresh = "2020-01-01T00:00:00Z";

describe("isolated native Help authentication", () => {
  it.each([undefined, "chatgpt", "chatgptAuthTokens"])(
    "preserves the selected account and access credentials without a refresh grant: %s",
    (mode) => {
      const source = JSON.stringify({
        auth_mode: mode,
        tokens,
        last_refresh: lastRefresh,
        private_config: "unrelated-private-data",
      });
      const original = JSON.parse(source);
      const result = isolatedCodexHelpAuth(source)!;
      expect(JSON.parse(result)).toEqual({
        auth_mode: mode ?? "chatgpt",
        tokens: {
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          account_id: tokens.account_id,
          refresh_token: "",
        },
        last_refresh: lastRefresh,
      });
      expect(result).not.toContain(tokens.refresh_token);
      expect(result).not.toContain(tokens.private_extension);
      expect(result).not.toContain("unrelated-private-data");
      expect(JSON.parse(source)).toEqual(original);
    },
  );

  it.each([undefined, "apikey"])(
    "preserves API-key authentication without copying other fields",
    (mode) => {
      const result = isolatedCodexHelpAuth(
        JSON.stringify({
          auth_mode: mode,
          OPENAI_API_KEY: "synthetic-key",
          private_config: "private",
        }),
      );
      expect(JSON.parse(result!)).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic-key" });
    },
  );

  it.each([
    "not JSON",
    "null",
    "[]",
    "{}",
    JSON.stringify({ auth_mode: "apikey", tokens, last_refresh: lastRefresh }),
    JSON.stringify({ auth_mode: "agentIdentity", tokens, last_refresh: lastRefresh }),
    JSON.stringify({ tokens, last_refresh: "invalid date" }),
    JSON.stringify({ tokens }),
    JSON.stringify({ tokens: { ...tokens, access_token: "" }, last_refresh: lastRefresh }),
    " ".repeat(256_001),
  ])("fails closed for unsupported, missing or invalid authentication", (source) => {
    expect(isolatedCodexHelpAuth(source)).toBeNull();
  });
});
