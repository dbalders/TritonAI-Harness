import { expect, it } from "vite-plus/test";
import { createMacPluginSandboxRuntime } from "./MacPluginSandboxRuntime.ts";
import { QUICKJS_RUNTIME_FILES } from "@t3tools/shared/pluginSandboxProfile";

it("rejects an unsupported platform before accessing or executing any supplied path", async () => {
  for (const platform of ["win32", "linux"] as const) {
    await expect(
      createMacPluginSandboxRuntime({
        platform,
        parentDirectory: "/not-created",
        runtime: { path: "/must-not-execute", sha256: "0".repeat(64) },
        supervisor: { path: "/must-not-execute", sha256: "0".repeat(64) },
        bootstrap: { path: "/must-not-read", sha256: "0".repeat(64) },
        engine: { path: "/must-not-read", sha256: "0".repeat(64) },
        bridge: { path: "/must-not-read", sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow("OS boundary is unavailable");
  }
});

it("rejects an unreviewed interpreter before accessing supplied files", async () => {
  await expect(
    createMacPluginSandboxRuntime({
      platform: "darwin",
      parentDirectory: "/not-created",
      runtime: { path: "/must-not-execute", sha256: "0".repeat(64) },
      supervisor: { path: "/must-not-execute", sha256: "0".repeat(64) },
      bootstrap: { path: "/must-not-read", sha256: QUICKJS_RUNTIME_FILES.bootstrap.sha256 },
      engine: { path: "/must-not-read", sha256: "0".repeat(64) },
      bridge: { path: "/must-not-read", sha256: QUICKJS_RUNTIME_FILES.bridge.sha256 },
    }),
  ).rejects.toThrow("host execution profile");
});
