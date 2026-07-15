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

const skillOnlyManifest: IntegrationManifest = {
  apiVersion: "tritonai.harness/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id: "skill-only-fixture",
  name: "Skill-only Fixture",
  description: "Test a bundled workflow without a provider.",
  version: "1.0.0",
  compatibility: { harness: { min: "0.2.0", maxExclusive: "0.3.0" } },
  capabilities: [
    { id: "workflow.use", displayName: "Use workflow", description: "Use local instructions." },
  ],
  tools: [],
  skills: [
    { name: "skill-only-fixture", description: "Local workflow.", capability: "workflow.use" },
  ],
};

describe("integration manifest semver", () => {
  it("allows skill-only bundles without a provider", () => {
    expect(validateIntegrationManifest(skillOnlyManifest)).toEqual(skillOnlyManifest);
    expect(() =>
      validateIntegrationManifest({
        ...skillOnlyManifest,
        tools: [
          {
            name: "fixture.write",
            displayName: "Write fixture",
            description: "Write fixture data.",
            capability: "workflow.use",
          },
        ],
      }),
    ).toThrow(/with tools must declare a provider/u);
  });

  it("keeps tool and skill names in their independent runtime namespaces", () => {
    expect(() =>
      validateIntegrationManifest({
        ...manifest,
        tools: [
          {
            name: "shared-component",
            displayName: "Shared component tool",
            description: "Tool namespace fixture.",
            capability: "fixture.read",
          },
        ],
        skills: [
          {
            name: "shared-component",
            description: "Skill namespace fixture.",
            capability: "fixture.read",
          },
        ],
      }),
    ).not.toThrow();
  });

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
          harness: { min: "0.2.5+catalog.7", maxExclusive: "0.3.0" },
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

  it("rejects ids that cannot form an isolated secret namespace", () => {
    for (const id of ["plugin-", "plugin.", "a..b", `p${"x".repeat(64)}`]) {
      expect(() => validateIntegrationManifest({ ...manifest, id })).toThrow(/identifiers/u);
    }
  });

  it("bounds canonical tool names to the Codex function-name limit", () => {
    expect(() =>
      validateIntegrationManifest({
        ...manifest,
        tools: [
          {
            name: `t${"x".repeat(128)}`,
            displayName: "Oversized tool",
            description: "Tool name exceeds the runtime contract.",
            capability: "fixture.read",
          },
        ],
      }),
    ).toThrow(/stable name/u);
  });

  it("rejects unsupported fields at every versioned manifest boundary", () => {
    const tool = {
      name: "fixture.read",
      displayName: "Read fixture",
      description: "Read fixture data.",
      capability: "fixture.read",
    };
    const skill = {
      name: "fixture-reader",
      description: "Read fixture data.",
      capability: "fixture.read",
    };
    const candidates = [
      { ...manifest, access: "read" },
      { ...manifest, compatibility: { ...manifest.compatibility, channel: "stable" } },
      {
        ...manifest,
        compatibility: {
          harness: { ...manifest.compatibility.harness, inclusiveMaximum: false },
        },
      },
      {
        ...manifest,
        capabilities: [{ ...manifest.capabilities[0]!, readOnly: true }],
      },
      { ...manifest, tools: [{ ...tool, readOnly: true }] },
      { ...manifest, skills: [{ ...skill, localOnly: true }] },
    ];

    for (const candidate of candidates) {
      expect(() => validateIntegrationManifest(candidate)).toThrow(/unsupported/u);
    }
  });
});
