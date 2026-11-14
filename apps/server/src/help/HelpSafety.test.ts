import { describe, expect, it } from "vite-plus/test";

import { redactHelpText } from "./HelpSafety.ts";

describe("Help text redaction", () => {
  it.each([
    ["API key", "API_KEY"],
    ["prefixed management key", "USAGE_MANAGEMENT_KEY"],
    ["prefix at the scan boundary", `${"a".repeat(64)}_API_KEY`],
    ["long prefix", `${"a".repeat(100_000)}_MANAGEMENT_KEY`],
    ["long prefix with underscores", `${"a_".repeat(50_000)}access_token`],
  ])("redacts the value after %s", (_label, key) => {
    expect(redactHelpText(`${key} = 'synthetic-credential'`)).toBe(`${key} = [REDACTED]`);
  });
});
