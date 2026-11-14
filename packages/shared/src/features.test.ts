import { describe, expect, it } from "vite-plus/test";

import { isFeatureAvailable, resolveFeatureEnvironment } from "./features.ts";

describe("feature environments", () => {
  it.each([
    ["0.4.1", "stable"],
    ["0.4.1-nightly.20261027.1", "nightly"],
    ["0.4.1-preview.20261027.1", "preview"],
    ["0.4.1-beta.1", "stable"],
    ["0.4.1-nightly", "stable"],
    ["", "stable"],
  ] as const)("classifies %s as %s", (version, expected) => {
    expect(resolveFeatureEnvironment({ version })).toBe(expected);
  });

  it("uses the hosted build channel when its package version differs", () => {
    expect(resolveFeatureEnvironment({ version: "0.4.1", channel: "nightly" })).toBe("nightly");
    expect(
      resolveFeatureEnvironment({ version: "0.4.1-nightly.20261027.1", channel: "stable" }),
    ).toBe("stable");
  });

  it("recognizes development without a prerelease version", () => {
    expect(resolveFeatureEnvironment({ version: "0.4.1", development: true })).toBe("development");
  });

  it.each([
    ["development", true],
    ["nightly", true],
    ["preview", true],
    ["stable", false],
  ] as const)("makes the tour available in %s: %s", (environment, available) => {
    expect(isFeatureAvailable("guidedTour", environment)).toBe(available);
  });
});
