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
    expect(input.config.schemaVersion).toBe(1);
    expect(
      input.config.models.catalog.some((model) => model.id === input.config.models.default),
    ).toBe(true);
    expect(input.digest).toBe(NodeCrypto.createHash("sha256").update(input.source).digest("hex"));
  });

  it("rejects unknown fields and missing catalog references", () => {
    expect(() =>
      parseManagedHarnessConfig(
        JSON.stringify({
          schemaVersion: 1,
          policyVersion: 1,
          provider: {
            instanceId: "codex",
            driver: "codex",
            managedBinary: true,
            managedHome: true,
            baseUrl: "https://tritonai.example.test/v1",
            apiKeyEnvironmentVariable: "TRITONAI_API_KEY",
          },
          models: {
            default: "missing",
            restrictedFallback: "missing",
            replacements: {},
            catalog: [{ id: "other", name: "Other" }],
          },
          secureSkills: { pollIntervalMinutes: 60 },
          unexpected: true,
        }),
      ),
    ).toThrow();
  });
});
