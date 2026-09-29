import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import { TRITONAI_IMAGE_CONTEXT_MODEL, type TritonAiManagedConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  loadManagedHarnessConfigForBuild,
  parseManagedHarnessConfig,
} from "./managed-harness-config.ts";

function configFixture() {
  return {
    schemaVersion: 2,
    policyVersion: 1,
    provider: {
      driver: "codex",
      managedBinary: true,
      managedHome: true,
      baseUrl: "https://tritonai.example.test/v1",
      sharedApiKeyEnvironmentVariable: "TRITONAI_API_KEY",
      apiKeySourceEnvironmentVariable: "TRITONAI_API_KEY_SOURCE",
      routes: {
        onPrem: {
          id: "on-prem",
          instanceId: "codex",
          displayName: "Local models",
          apiKeyEnvironmentVariable: "TRITONAI_ONPREM_API_KEY",
        },
        frontier: {
          id: "frontier",
          instanceId: "codex_frontier",
          displayName: "Cloud models",
          apiKeyEnvironmentVariable: "TRITONAI_FRONTIER_API_KEY",
        },
      },
    },
    models: {
      default: "synthetic-text",
      restrictedFallback: "synthetic-text",
      replacements: {},
      catalog: [
        {
          id: "synthetic-text",
          name: "Text",
          route: "on-prem",
          capabilities: { inputModalities: ["text"] },
        },
        // This identifier is a parser contract: the dedicated image-context model must accept images.
        {
          id: TRITONAI_IMAGE_CONTEXT_MODEL,
          name: "Image",
          route: "on-prem",
          capabilities: { inputModalities: ["text", "image"] },
        },
        { id: "synthetic-cloud", name: "Cloud", route: "frontier" },
      ],
    },
    secureSkills: { pollIntervalMinutes: 60 },
  } satisfies TritonAiManagedConfig;
}

describe("managed Harness config build input", () => {
  it("loads and validates the committed release payload with a stable identity", () => {
    const input = loadManagedHarnessConfigForBuild(
      NodeURL.fileURLToPath(new URL("../..", import.meta.url)),
    );
    expect(input.digest).toBe(NodeCrypto.createHash("sha256").update(input.source).digest("hex"));
  });

  it("accepts explicit modalities and rejects missing text or image support", () => {
    const fixture = configFixture();
    expect(parseManagedHarnessConfig(JSON.stringify(fixture))).toEqual(fixture);

    const missingText = configFixture();
    delete missingText.models.catalog[0]!.capabilities;
    expect(() => parseManagedHarnessConfig(JSON.stringify(missingText))).toThrow(/text input/u);

    const missingImage = configFixture();
    missingImage.models.catalog[1]!.capabilities = { inputModalities: ["text"] };
    expect(() => parseManagedHarnessConfig(JSON.stringify(missingImage))).toThrow(/image input/u);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseManagedHarnessConfig(JSON.stringify({ ...configFixture(), unexpected: true })),
    ).toThrow(/unexpected/u);
  });

  it.each(["default", "restrictedFallback", "replacements"] as const)(
    "rejects missing catalog references in %s",
    (field) => {
      const fixture = configFixture();
      if (field === "replacements") fixture.models.replacements = { retired: "missing" };
      else fixture.models[field] = "missing";
      expect(() => parseManagedHarnessConfig(JSON.stringify(fixture))).toThrow(/catalog/u);
    },
  );

  it("rejects a valid route schema whose catalog omits frontier models", () => {
    const fixture = configFixture();
    fixture.models.catalog = fixture.models.catalog.filter((model) => model.route === "on-prem");
    expect(() => parseManagedHarnessConfig(JSON.stringify(fixture))).toThrow(/frontier/u);
  });

  it("rejects invalid engine approvals and accepts missing approval for fail-closed compatibility", () => {
    const fixture = configFixture();
    for (const approvedCodexVersion of ["latest", "^1.2.3", "1.2.3;echo unsafe", "01.2.3"]) {
      expect(() =>
        parseManagedHarnessConfig(
          JSON.stringify({
            ...fixture,
            provider: { ...fixture.provider, approvedCodexVersion },
          }),
        ),
      ).toThrow();
    }
    expect(
      parseManagedHarnessConfig(JSON.stringify(fixture)).provider.approvedCodexVersion,
    ).toBeUndefined();
  });
});
