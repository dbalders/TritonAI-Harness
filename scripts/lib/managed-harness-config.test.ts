import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import * as NodeURL from "node:url";

import {
  loadManagedHarnessConfigForBuild,
  parseManagedHarnessConfig,
} from "./managed-harness-config.ts";

describe("managed Harness config build input", () => {
  it("loads the committed release payload with a stable identity", () => {
    const input = loadManagedHarnessConfigForBuild(
      NodeURL.fileURLToPath(new URL("../..", import.meta.url)),
    );
    expect(input.config.schemaVersion).toBe(2);
    expect(
      input.config.models.catalog.some((model) => model.id === input.config.models.default),
    ).toBe(true);
    expect(input.digest).toBe(NodeCrypto.createHash("sha256").update(input.source).digest("hex"));
  });

  it("keeps explicit modalities for managed on-prem and image-context models", () => {
    const input = loadManagedHarnessConfigForBuild(
      NodeURL.fileURLToPath(new URL("../..", import.meta.url)),
    );
    const models = Object.fromEntries(
      input.config.models.catalog.map((model) => [model.id, model]),
    );

    expect(models["api-deepseek-v4-flash"]?.capabilities?.inputModalities).toEqual(["text"]);
    expect(models["api-glm-5.3"]?.capabilities?.inputModalities).toEqual(["text"]);
    expect(models["api-gemma-4-31b"]?.capabilities?.inputModalities).toEqual(["text", "image"]);
  });

  it("rejects missing on-prem and image-context modality declarations", () => {
    const input = loadManagedHarnessConfigForBuild(
      NodeURL.fileURLToPath(new URL("../..", import.meta.url)),
    );
    const missingGlmCapabilities = JSON.parse(input.source) as {
      models: { catalog: Array<{ id: string; capabilities?: unknown }> };
    };
    const glm = missingGlmCapabilities.models.catalog.find((model) => model.id === "api-glm-5.3");
    delete glm?.capabilities;

    expect(() => parseManagedHarnessConfig(JSON.stringify(missingGlmCapabilities))).toThrow(
      /api-glm-5\.3.*text input/u,
    );

    const textOnlyGemma = JSON.parse(input.source) as {
      models: {
        catalog: Array<{
          id: string;
          capabilities?: { inputModalities?: string[] };
        }>;
      };
    };
    const gemma = textOnlyGemma.models.catalog.find((model) => model.id === "api-gemma-4-31b");
    if (gemma?.capabilities) gemma.capabilities.inputModalities = ["text"];

    expect(() => parseManagedHarnessConfig(JSON.stringify(textOnlyGemma))).toThrow(
      /api-gemma-4-31b.*image input/u,
    );
  });

  it("rejects unknown fields and missing catalog references", () => {
    expect(() =>
      parseManagedHarnessConfig(
        JSON.stringify({
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
                displayName: "On-prem models",
                apiKeyEnvironmentVariable: "TRITONAI_ONPREM_API_KEY",
              },
              frontier: {
                id: "frontier",
                instanceId: "codex_frontier",
                displayName: "Frontier models",
                apiKeyEnvironmentVariable: "TRITONAI_FRONTIER_API_KEY",
              },
            },
          },
          models: {
            default: "missing",
            restrictedFallback: "missing",
            replacements: {},
            catalog: [{ id: "other", name: "Other", route: "on-prem" }],
          },
          secureSkills: { pollIntervalMinutes: 60 },
          unexpected: true,
        }),
      ),
    ).toThrow();
  });

  it("rejects a valid route schema whose catalog omits frontier models", () => {
    expect(() =>
      parseManagedHarnessConfig(
        JSON.stringify({
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
                displayName: "On-prem models",
                apiKeyEnvironmentVariable: "TRITONAI_ONPREM_API_KEY",
              },
              frontier: {
                id: "frontier",
                instanceId: "codex_frontier",
                displayName: "Frontier models",
                apiKeyEnvironmentVariable: "TRITONAI_FRONTIER_API_KEY",
              },
            },
          },
          models: {
            default: "on-prem-model",
            restrictedFallback: "on-prem-model",
            replacements: {},
            catalog: [{ id: "on-prem-model", name: "On-prem model", route: "on-prem" }],
          },
          secureSkills: { pollIntervalMinutes: 60 },
        }),
      ),
    ).toThrow(/frontier/i);
  });
});
