import { expect, it } from "vite-plus/test";
import { createBundledPluginSandbox } from "./BundledPluginSandbox.ts";

it("keeps providers unavailable when their platform or sealed bundle is absent", async () => {
  expect(
    await createBundledPluginSandbox("/must-not-read", { platform: "darwin", arch: "arm64" }, null),
  ).toBeNull();
  expect(
    await createBundledPluginSandbox(
      "/must-not-read",
      { platform: "win32", arch: "x64" },
      { malformed: true },
    ),
  ).toBeNull();
  await expect(
    createBundledPluginSandbox(
      "/must-not-read",
      { platform: "darwin", arch: "arm64" },
      { malformed: true },
    ),
  ).rejects.toThrow();
});
