import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TRITONAI_AI_BASE_URL,
  DEFAULT_TRITONAI_CODEX_HOME_PATH,
  DEFAULT_TRITONAI_CODEX_MODEL,
  TRITONAI_APP_BASE_NAME,
  TRITONAI_APP_ID_BASE,
} from "@t3tools/contracts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { loadBuiltinIntegrations } from "../integrations/builtins.ts";
import { type IntegrationManifest, validateIntegrationManifest } from "../integrations/manifest.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import {
  computeDynamicToolFingerprint,
  readCompatibleResumeThreadId,
} from "./Layers/CodexSessionRuntime.ts";
import { tritonAiCodexCapabilities } from "./Layers/CodexProvider.ts";

describe("downstream provider and integration policy", () => {
  it("keeps the default integration catalog fixed and capability access explicit", async () => {
    const unusedSecrets = {} as ServerSecretStore.ServerSecretStore["Service"];
    await expect(loadBuiltinIntegrations(unusedSecrets)).resolves.toEqual([]);

    const manifest = validateIntegrationManifest({
      apiVersion: "tritonai.harness/v2",
      kind: "IntegrationPlugin",
      manifestVersion: 2,
      id: "upstream-safety-fixture",
      name: "Upstream Safety Fixture",
      description: "Verify downstream capability policy.",
      version: "1.0.0",
      capabilities: [
        {
          id: "records.write",
          displayName: "Change records",
          description: "Change protected records.",
          access: "opt-in",
        },
      ],
      tools: [],
      skills: [
        {
          name: "upstream-safety-fixture",
          description: "Change protected records.",
          capabilities: ["records.write"],
        },
      ],
    } satisfies IntegrationManifest);

    expect(manifest.capabilities).toEqual([
      {
        id: "records.write",
        displayName: "Change records",
        description: "Change protected records.",
        access: "opt-in",
      },
    ]);
    expect(manifest.skills[0]?.capabilities).toEqual(["records.write"]);
    expect(() =>
      validateIntegrationManifest({
        ...manifest,
        installUrl: "https://plugins.example.invalid/arbitrary-plugin.tgz",
      }),
    ).toThrow(/unsupported fields/u);
  });

  it("binds dynamic-tool grants into Codex resume compatibility", () => {
    const tool = {
      name: "fixture_records_search",
      description: "Read fixture records.",
      inputSchema: { type: "object" },
    } as const;
    const cursor = {
      threadId: "provider-thread",
      dynamicToolNames: [tool.name],
      dynamicToolFingerprint: computeDynamicToolFingerprint([tool]),
    };

    expect(readCompatibleResumeThreadId(cursor, [tool])).toBe("provider-thread");
    expect(
      readCompatibleResumeThreadId(cursor, [
        { ...tool, description: "Changed capability contract." },
      ]),
    ).toBeUndefined();
    expect(readCompatibleResumeThreadId(cursor, [])).toBeUndefined();
  });

  it("pins TritonAI identity and conservative provider defaults", () => {
    const capabilities = tritonAiCodexCapabilities(null);
    const reasoning = capabilities.optionDescriptors?.find(
      (descriptor) => descriptor.id === "reasoningEffort",
    );

    expect(TRITONAI_APP_BASE_NAME).toBe("TritonAI Harness");
    expect(TRITONAI_APP_ID_BASE).toBe("edu.ucsd.tritonai.harness");
    expect(DEFAULT_TRITONAI_AI_BASE_URL).toBe("https://tritonai-api.ucsd.edu/v1");
    expect(DEFAULT_TRITONAI_CODEX_MODEL).toBe("api-deepseek-v4-flash");
    expect(DEFAULT_SERVER_SETTINGS.enableProviderUpdateChecks).toBe(false);
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: "codex",
      model: DEFAULT_TRITONAI_CODEX_MODEL,
    });
    expect(DEFAULT_SERVER_SETTINGS.providers.codex).toMatchObject({
      enabled: true,
      customModels: [DEFAULT_TRITONAI_CODEX_MODEL],
    });
    expect(reasoning).toMatchObject({
      type: "select",
      currentValue: "medium",
      options: expect.arrayContaining([{ id: "medium", label: "Medium", isDefault: true }]),
    });
  });
});

it.layer(NodeServices.layer)("managed Codex home policy", (it) => {
  it.effect("uses the TritonAI home and keeps shadow authentication private", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const defaultLayout = yield* resolveCodexHomeLayout(DEFAULT_SERVER_SETTINGS.providers.codex);
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tritonai-upstream-safety-" });
      const sharedHome = path.join(root, "managed-codex");
      const shadowHome = path.join(root, "personal-codex");

      expect(defaultLayout).toMatchObject({
        mode: "direct",
        effectiveHomePath: undefined,
      });
      expect(path.basename(defaultLayout.sharedHomePath)).toBe("codex");
      expect(path.basename(path.dirname(defaultLayout.sharedHomePath))).toBe(".tritonai-harness");

      yield* fs.makeDirectory(path.join(sharedHome, "sessions"), { recursive: true });
      yield* fs.makeDirectory(shadowHome, { recursive: true });
      yield* fs.writeFileString(path.join(sharedHome, "auth.json"), '{"managed":true}\n');
      yield* fs.writeFileString(path.join(shadowHome, "auth.json"), '{"personal":true}\n');

      const layout = yield* resolveCodexHomeLayout({
        enabled: true,
        binaryPath: "",
        homePath: sharedHome,
        shadowHomePath: shadowHome,
        customModels: [DEFAULT_TRITONAI_CODEX_MODEL],
        customModelMetadata: {},
      });
      yield* materializeCodexShadowHome(layout);

      expect(DEFAULT_TRITONAI_CODEX_HOME_PATH).toBe("~/.tritonai-harness/codex");
      expect(layout).toMatchObject({
        mode: "authOverlay",
        sharedHomePath: sharedHome,
        effectiveHomePath: shadowHome,
      });
      expect(yield* fs.readLink(path.join(shadowHome, "sessions"))).toBe(
        path.join(sharedHome, "sessions"),
      );
      expect(yield* fs.readFileString(path.join(shadowHome, "auth.json"))).toBe(
        '{"personal":true}\n',
      );
      expect(
        (yield* fs.readLink(path.join(shadowHome, "auth.json")).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  );
});
