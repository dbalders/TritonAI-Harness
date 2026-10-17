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
    [{ peerDependencies: { effect: EFFECT_HOST_PEER_RANGE } }, "peer"],
    [{ dependencies: { effect: "4.0.0-beta.78" } }, "legacy-dependency"],
  ] as const)(
    "runs supported plugin declarations against the release candidate host",
    (metadata, declaration) => {
      expect(resolvePluginHostRuntimeDependencies(metadata, "4.0.0-rc.112")).toEqual([
        { name: "effect", version: "4.0.0-rc.112", declaration },
      ]);
    },
  );

  it.each(["4.0.0", "4.0.4", "4.1.0", "4.0.4+build.1"])(
    "supports stable Effect host %s with released and current declarations",
    (host) => {
      for (const metadata of [
        { dependencies: { effect: "4.0.0-beta.78" } },
        { peerDependencies: { effect: ">=4.0.0-beta.78 <4.0.0" } },
        { peerDependencies: { effect: EFFECT_HOST_PEER_RANGE } },
      ])
        expect(resolvePluginHostRuntimeDependencies(metadata, host)[0]?.version).toBe(host);
    },
  );

  it.each([
    "4.0.0-beta.77",
    "4.0.0-alpha.112",
    "4.0.0-rc.01",
    "4.0.0-rc.NaN",
    "5.0.0",
    "4.0.1-rc.1",
  ])("rejects unsupported host %s", (host) => {
    expect(() =>
      resolvePluginHostRuntimeDependencies(
        { peerDependencies: { effect: EFFECT_HOST_PEER_RANGE } },
        host,
      ),
    ).toThrow(/host-runtime contract/);
  });

  it.each(["bundledDependencies", "bundleDependencies"] as const)(
    "rejects packages using the %s npm bundling alias",
    (field) => {
      expect(() =>
        resolvePluginHostRuntimeDependencies(
          {
            peerDependencies: { effect: EFFECT_HOST_PEER_RANGE },
            [field]: ["effect"],
          },
          "4.0.0-beta.102",
        ),
      ).toThrow(/cannot bundle runtime dependencies/iu);
    },
  );

  it.each([
    [{ dependencies: { effect: "4.0.0-rc.112" } }, "4.0.0-rc.112"],
    [{ dependencies: { effect: "4.0.0-beta.103" } }, "4.0.0-beta.102"],
    [{ dependencies: { effect: "4.0.0-beta.102" } }, "4.0.0-beta.102"],
    [{ dependencies: { effect: "4.0.0-beta.79" } }, "4.0.0-beta.102"],
    [{ dependencies: { effect: "4.0.0-beta.77" } }, "4.0.0-beta.102"],
    [{ dependencies: { effect: "4.0.0-beta.78", other: "1.0.0" } }, "4.0.0-beta.102"],
    [{ peerDependencies: { effect: ">=4.0.0-beta.1 <5.0.0" } }, "4.0.0-beta.102"],
    [{ optionalDependencies: { effect: "4.0.0-beta.78" } }, "4.0.0-beta.102"],
    [{ dependencies: { effect: "4.0.0-beta.78" } }, "5.0.0"],
  ])("rejects dependencies outside the narrow host contract", (packageJson, hostVersion) => {
    expect(() => resolvePluginHostRuntimeDependencies(packageJson, hostVersion)).toThrow();
  });
});
