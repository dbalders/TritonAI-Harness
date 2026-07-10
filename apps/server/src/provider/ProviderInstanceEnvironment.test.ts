import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "TOOL_SETTING", value: "configured", sensitive: true },
          { name: "EMPTY_SETTING", value: "", sensitive: false },
        ],
        { EMPTY_SETTING: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      TOOL_SETTING: "configured",
      EMPTY_SETTING: "",
      PATH: "/bin",
    });
  });

  it("deduplicates Windows environment keys case-insensitively", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "PATH", value: "C:\\Users\\tester\\AppData\\Roaming\\npm", sensitive: false }],
        {
          Path: "C:\\Windows\\System32",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
        "win32",
      ),
    ).toEqual({
      PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
  });

  it("preserves differently-cased keys on non-Windows hosts", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "PATH", value: "/custom/bin", sensitive: false }],
        { Path: "/inherited/bin" },
        "darwin",
      ),
    ).toEqual({ Path: "/inherited/bin", PATH: "/custom/bin" });
  });
});
