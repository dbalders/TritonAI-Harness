import { describe, expect, it } from "@effect/vitest";

import {
  manifestCompatibility,
  type IntegrationManifest,
  validateIntegrationManifest,
} from "./manifest.ts";

const manifest: IntegrationManifest = {
  apiVersion: "tritonai.harness/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id: "semver-fixture",
  name: "Semver Fixture",
  description: "Test integration compatibility ranges.",
  version: "1.0.0",
  compatibility: { harness: { min: "0.2.0", maxExclusive: "0.3.0" } },
  provider: "semver-fixture-provider",
  capabilities: [
    { id: "fixture.read", displayName: "Read fixture", description: "Read fixture data." },
  ],
  tools: [],
  skills: [],
};

describe("integration manifest semver", () => {
  it("uses SemVer prerelease precedence for compatibility ranges", () => {
    expect(() =>
      validateIntegrationManifest({
        ...manifest,
        compatibility: {
          harness: { min: "0.2.6-alpha.2", maxExclusive: "0.2.6-alpha.10" },
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateIntegrationManifest({
        ...manifest,
        compatibility: { harness: { min: "0.2.6-beta.1", maxExclusive: "0.2.6" } },
      }),
    ).not.toThrow();
  });

  it("ignores build metadata when comparing Harness versions", () => {
    const result = manifestCompatibility(
      validateIntegrationManifest({
        ...manifest,
        compatibility: {
          harness: { min: "0.2.5+catalog.7", maxExclusive: "0.2.6-alpha.1" },
        },
      }),
    );
    expect(result).toEqual({ compatible: true, message: null });
  });

  it("rejects numeric prerelease identifiers with leading zeroes", () => {
    expect(() => validateIntegrationManifest({ ...manifest, version: "1.0.0-alpha.01" })).toThrow(
      /semver/u,
    );
  });
});
