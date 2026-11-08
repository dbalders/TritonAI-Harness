import { describe, expect, it } from "vite-plus/test";

import { redactHelpText, safeHelpText } from "./HelpSafety.ts";

describe("Help text redaction", () => {
  it.each([
    ["API key", "API_KEY"],
    ["access token", "access_token"],
    ["management key", "managementKey"],
    ["prefixed management key", "USAGE_MANAGEMENT_KEY"],
    ["prefix at the scan boundary", `${"a".repeat(64)}_API_KEY`],
    ["long prefix", `${"a".repeat(100_000)}_MANAGEMENT_KEY`],
    ["long prefix with underscores", `${"a_".repeat(50_000)}access_token`],
  ])("redacts the value after %s", (_label, key) => {
    expect(redactHelpText(`${key} = 'synthetic-credential'`)).toBe(`${key} = [REDACTED]`);
  });

  it("preserves long ordinary values and truncates the sanitized result", () => {
    const value = "a".repeat(100_000);
    expect(redactHelpText(value)).toBe(value);
    expect(safeHelpText(value, 128)).toBe("a".repeat(128));
  });
});
