import { expect, it } from "vite-plus/test";
import { createMacPluginSandboxRuntime } from "./MacPluginSandboxRuntime.ts";

it("rejects an unsupported platform before accessing or executing any supplied path", async () => {
  for (const platform of ["win32", "linux"] as const) {
    await expect(
      createMacPluginSandboxRuntime({
        platform,
        parentDirectory: "/not-created",
        runtime: { path: "/must-not-execute", sha256: "0".repeat(64) },
        supervisor: { path: "/must-not-execute", sha256: "0".repeat(64) },
        bootstrap: { path: "/must-not-read", sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow("OS boundary is unavailable");
  }
});
