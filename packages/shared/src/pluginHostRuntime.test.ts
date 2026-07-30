import { describe, expect, it } from "vite-plus/test";

import {
  EFFECT_HOST_PEER_RANGE,
  resolvePluginHostRuntimeDependencies,
} from "./pluginHostRuntime.ts";

describe("managed plugin host runtime", () => {
  it("runs the released beta.78 package against the newer Harness runtime", () => {
    expect(
      resolvePluginHostRuntimeDependencies(
        { dependencies: { effect: "4.0.0-beta.78" } },
        "4.0.0-beta.102",
      ),
    ).toEqual([{ name: "effect", version: "4.0.0-beta.102", declaration: "legacy-dependency" }]);
  });

  it("accepts the canonical peer contract without an exact runtime equality pin", () => {
    expect(
      resolvePluginHostRuntimeDependencies(
        { peerDependencies: { effect: EFFECT_HOST_PEER_RANGE } },
        "4.0.0-beta.103",
      ),
    ).toEqual([{ name: "effect", version: "4.0.0-beta.103", declaration: "peer" }]);
  });

  it.each([
    [{ dependencies: { effect: "4.0.0-beta.103" } }, "4.0.0-beta.102"],
    [{ dependencies: { effect: "4.0.0-beta.77" } }, "4.0.0-beta.102"],
    [{ dependencies: { effect: "4.0.0-beta.78", other: "1.0.0" } }, "4.0.0-beta.102"],
    [{ peerDependencies: { effect: ">=4.0.0-beta.1 <5.0.0" } }, "4.0.0-beta.102"],
    [{ optionalDependencies: { effect: "4.0.0-beta.78" } }, "4.0.0-beta.102"],
    [{ dependencies: { effect: "4.0.0-beta.78" } }, "4.0.0"],
  ])("rejects dependencies outside the narrow host contract", (packageJson, hostVersion) => {
    expect(() => resolvePluginHostRuntimeDependencies(packageJson, hostVersion)).toThrow();
  });
});
