import { describe, expect, it } from "@effect/vitest";

import { type IntegrationManifest, validateIntegrationManifest } from "./manifest.ts";

const manifest: IntegrationManifest = {
  apiVersion: "tritonai.harness/v2",
  kind: "IntegrationPlugin",
  manifestVersion: 2,
  id: "manifest-fixture",
  name: "Manifest Fixture",
  description: "Test the current integration manifest contract.",
  version: "1.0.0",
  provider: "manifest-fixture-provider",
  capabilities: [
    {
      id: "fixture.read",
      displayName: "Read fixture",
      description: "Read fixture data.",
      access: "default",
    },
  ],
  tools: [],
  skills: [],
};

const skillOnlyManifest: IntegrationManifest = {
  apiVersion: "tritonai.harness/v2",
  kind: "IntegrationPlugin",
  manifestVersion: 2,
  id: "skill-only-fixture",
  name: "Skill-only Fixture",
  description: "Test a bundled workflow without a provider.",
  version: "1.0.0",
  capabilities: [
    {
      id: "workflow.use",
      displayName: "Use workflow",
      description: "Use local instructions.",
      access: "default",
    },
  ],
  tools: [],
  skills: [
    {
      name: "skill-only-fixture",
      description: "Local workflow.",
      capabilities: ["workflow.use"],
    },
  ],
};

describe("integration manifest v2", () => {
  it("accepts the one current contract and skill-only bundles", () => {
    expect(validateIntegrationManifest(manifest)).toEqual(manifest);
    expect(validateIntegrationManifest(skillOnlyManifest)).toEqual(skillOnlyManifest);
  });

  it("does not retain mutable capability references from caller input", () => {
    const toolCapabilities = ["fixture.read"];
    const skillCapabilities = ["fixture.read"];
    const validated = validateIntegrationManifest({
      ...manifest,
      tools: [
        {
          name: "fixture.read",
          displayName: "Read fixture",
          description: "Read fixture data.",
          capabilities: toolCapabilities,
          effect: "read",
        },
      ],
      skills: [
        {
          name: "fixture-reader",
          description: "Read fixture data.",
          capabilities: skillCapabilities,
        },
      ],
    });

    toolCapabilities[0] = "caller.mutation";
    skillCapabilities[0] = "caller.mutation";

    expect(validated.tools[0]?.capabilities).toEqual(["fixture.read"]);
    expect(validated.skills[0]?.capabilities).toEqual(["fixture.read"]);
  });

  it("requires a provider for tool bundles", () => {
    expect(() =>
      validateIntegrationManifest({
        ...skillOnlyManifest,
        tools: [
          {
            name: "fixture.write",
            displayName: "Write fixture",
            description: "Write fixture data.",
            capabilities: ["workflow.use"],
            effect: "write",
          },
        ],
      }),
    ).toThrow(/with tools must declare a provider/u);
  });

  it("keeps tool and skill names in independent runtime namespaces", () => {
    expect(() =>
      validateIntegrationManifest({
        ...manifest,
        tools: [
          {
            name: "shared-component",
            displayName: "Shared component tool",
            description: "Tool namespace fixture.",
            capabilities: ["fixture.read"],
            effect: "read",
          },
        ],
        skills: [
          {
            name: "shared-component",
            description: "Skill namespace fixture.",
            capabilities: ["fixture.read"],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects numeric prerelease identifiers with leading zeroes", () => {
    expect(() => validateIntegrationManifest({ ...manifest, version: "1.0.0-alpha.01" })).toThrow(
      /semver/u,
    );
  });

  it("rejects identifiers, names, and versions with trailing line terminators", () => {
    expect(() => validateIntegrationManifest({ ...manifest, id: `${manifest.id}\n` })).toThrow(
      /identifiers/u,
    );
    expect(() =>
      validateIntegrationManifest({
        ...manifest,
        tools: [
          {
            name: "fixture.read\n",
            displayName: "Read fixture",
            description: "Read fixture data.",
            capabilities: ["fixture.read"],
            effect: "read",
          },
        ],
      }),
    ).toThrow(/stable name/u);
    expect(() =>
      validateIntegrationManifest({
        ...skillOnlyManifest,
        skills: [
          {
            ...skillOnlyManifest.skills[0]!,
            name: `${skillOnlyManifest.skills[0]!.name}\n`,
          },
        ],
      }),
    ).toThrow(/stable name/u);
    expect(() =>
      validateIntegrationManifest({ ...manifest, version: `${manifest.version}\n` }),
    ).toThrow(/semver/u);
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
            capabilities: ["fixture.read"],
            effect: "read",
          },
        ],
      }),
    ).toThrow(/stable name/u);
  });

  it("rejects removed compatibility aliases and missing current fields", () => {
    const tool = {
      name: "fixture.read",
      displayName: "Read fixture",
      description: "Read fixture data.",
      capabilities: ["fixture.read"],
      effect: "read",
    };
    const skill = {
      name: "fixture-reader",
      description: "Read fixture data.",
      capabilities: ["fixture.read"],
    };
    const candidates = [
      { ...manifest, apiVersion: "tritonai.harness/v1", manifestVersion: 1 },
      { ...manifest, compatibility: { harness: { min: "0.2.0", maxExclusive: "0.3.0" } } },
      {
        ...manifest,
        capabilities: [{ id: "fixture.read", displayName: "Read", description: "Read data." }],
      },
      { ...manifest, tools: [{ ...tool, capabilities: undefined, capability: "fixture.read" }] },
      { ...manifest, tools: [{ ...tool, effect: undefined }] },
      { ...manifest, skills: [{ ...skill, capabilities: undefined, capability: "fixture.read" }] },
    ];

    for (const candidate of candidates) {
      expect(() => validateIntegrationManifest(candidate)).toThrow();
    }
  });

  it("rejects unsupported fields at every versioned manifest boundary", () => {
    const tool = {
      name: "fixture.read",
      displayName: "Read fixture",
      description: "Read fixture data.",
      capabilities: ["fixture.read"],
      effect: "read" as const,
    };
    const skill = {
      name: "fixture-reader",
      description: "Read fixture data.",
      capabilities: ["fixture.read"],
    };
    const candidates = [
      { ...manifest, access: "read" },
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
