import { describe, expect, it } from "vite-plus/test";

import { runtimeModeConfig } from "./ChatComposer";

describe("runtime mode copy", () => {
  it("describes the Supervised permission boundary without promising every command asks", () => {
    expect(runtimeModeConfig["approval-required"]).toMatchObject({
      label: "Supervised",
      description:
        "Safe read-only commands may run; ask before commands needing more access, file changes, and write tools.",
    });
  });

  it("keeps Auto-accept edits and Full access behavior explicit", () => {
    expect(runtimeModeConfig["auto-accept-edits"]).toMatchObject({
      label: "Auto-accept edits",
      description: "Auto-approve edits, ask before other actions.",
    });
    expect(runtimeModeConfig["full-access"]).toMatchObject({
      label: "Full access",
      description: "Allow commands and edits without prompts.",
    });
  });
});
