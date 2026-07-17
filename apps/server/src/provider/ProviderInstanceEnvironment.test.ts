import { describe, expect, it } from "vite-plus/test";

import {
  mergeProviderInstanceEnvironment,
  withoutInheritedCodexNetworkSandboxMarker,
} from "./ProviderInstanceEnvironment.ts";

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

describe("withoutInheritedCodexNetworkSandboxMarker", () => {
  it("removes the inherited network marker without mutating the source environment", () => {
    const environment = {
      CODEX_SANDBOX: "seatbelt",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      PATH: "/bin",
    };

    expect(withoutInheritedCodexNetworkSandboxMarker(environment, "darwin")).toEqual({
      CODEX_SANDBOX: "seatbelt",
      PATH: "/bin",
    });
    expect(environment).toEqual({
      CODEX_SANDBOX: "seatbelt",
      CODEX_SANDBOX_NETWORK_DISABLED: "1",
      PATH: "/bin",
    });
  });

  it("removes the network marker case-insensitively on Windows", () => {
    expect(
      withoutInheritedCodexNetworkSandboxMarker(
        {
          Codex_Sandbox: "windows",
          codex_sandbox_network_disabled: "1",
          PATH: "C:\\Windows\\System32",
        },
        "win32",
      ),
    ).toEqual({ Codex_Sandbox: "windows", PATH: "C:\\Windows\\System32" });
  });

  it("preserves a network marker explicitly configured for the provider", () => {
    const inheritedEnvironment = withoutInheritedCodexNetworkSandboxMarker(
      { CODEX_SANDBOX_NETWORK_DISABLED: "1", PATH: "/bin" },
      "darwin",
    );

    expect(
      mergeProviderInstanceEnvironment(
        [
          {
            name: "CODEX_SANDBOX_NETWORK_DISABLED",
            value: "configured",
            sensitive: false,
          },
        ],
        inheritedEnvironment,
        "darwin",
      ),
    ).toEqual({ CODEX_SANDBOX_NETWORK_DISABLED: "configured", PATH: "/bin" });
  });

  it("keeps the marker removed when the provider has no environment overrides", () => {
    const inheritedEnvironment = withoutInheritedCodexNetworkSandboxMarker(
      { CODEX_SANDBOX_NETWORK_DISABLED: "1", PATH: "/bin" },
      "darwin",
    );

    expect(mergeProviderInstanceEnvironment(undefined, inheritedEnvironment, "darwin")).toEqual({
      PATH: "/bin",
    });
  });
});
