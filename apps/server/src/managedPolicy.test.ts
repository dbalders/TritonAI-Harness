import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TRITONAI_CODEX_HOME_PATH,
  ProviderDriverKind,
  ProviderInstanceId,
  type TritonAiManagedConfig,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyManagedHarnessPolicy,
  createManagedProfileSettings,
  getManagedProviderInstanceRenames,
  managedConfig,
  migrateLegacyInstallerManagedSettings,
  stripManagedFieldsForPersistence,
  validateBundledManagedConfig,
} from "./managedPolicy.ts";

const managedInstanceId = ProviderInstanceId.make("codex");
const frontierInstanceId = ProviderInstanceId.make("codex_frontier");

describe("TritonAI managed Harness policy", () => {
  beforeEach(() => {
    migrateLegacyInstallerManagedSettings({
      tritonAiManagedPolicy: {
        migrationVersion: 2,
        codexBinaryPath: DEFAULT_SERVER_SETTINGS.providers.codex.binaryPath,
        codexHomePath: DEFAULT_TRITONAI_CODEX_HOME_PATH,
      },
    });
  });

  it("rejects malformed or identity-mismatched production resources", () => {
    expect(() =>
      validateBundledManagedConfig('{"schemaVersion":2}', managedConfig, "0".repeat(64)),
    ).toThrow();
    const validSource = JSON.stringify(managedConfig);
    expect(() => validateBundledManagedConfig(validSource, managedConfig, "0".repeat(64))).toThrow(
      /identity mismatch/u,
    );
  });

  it("locks the managed Codex identity, route, runtime, and catalog", () => {
    const effective = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          enabled: false,
          binaryPath: "/tmp/personal-codex",
          homePath: "~/.codex",
        },
      },
      providerInstances: {
        [managedInstanceId]: {
          driver: ProviderDriverKind.make("opencode"),
          enabled: false,
          environment: [
            {
              name: "UCSD_AI_BASE_URL",
              value: "https://unmanaged.example.test/v1",
              sensitive: false,
            },
            { name: "USER_SETTING", value: "preserved", sensitive: false },
          ],
          config: { binaryPath: "/tmp/personal-codex", userDefined: true },
        },
      },
    });

    expect(effective.providers.codex.binaryPath).toBe("codex");
    expect(effective.providers.codex.homePath).toBe(DEFAULT_TRITONAI_CODEX_HOME_PATH);
    expect(effective.providerInstances[managedInstanceId]?.driver).toBe("codex");
    expect(effective.providerInstances[managedInstanceId]?.config).toMatchObject({
      binaryPath: "codex",
      homePath: DEFAULT_TRITONAI_CODEX_HOME_PATH,
      userDefined: true,
    });
    expect(effective.providerInstances[managedInstanceId]?.environment).toEqual([
      { name: "USER_SETTING", value: "preserved", sensitive: false },
      { name: "UCSD_AI_BASE_URL", value: managedConfig.provider.baseUrl, sensitive: false },
      {
        name: "TRITONAI_API_KEY_SOURCE",
        value: "TRITONAI_ONPREM_API_KEY",
        sensitive: false,
      },
    ]);
    expect(effective.providerInstances[managedInstanceId]?.config).toMatchObject({
      customModels: ["api-glm-5.3-flash", "api-glm-5.3", "api-muse-glimmer-30b"],
      customModelMetadata: {
        "api-glm-5.3-flash": {
          capabilities: {
            inputModalities: ["text", "image"],
            optionDescriptors: [
              {
                id: "reasoningEffort",
                options: [{ id: "low" }, { id: "high", isDefault: true }, { id: "xhigh" }],
                currentValue: "high",
              },
            ],
          },
        },
        "api-glm-5.3": {
          capabilities: {
            inputModalities: ["text"],
            optionDescriptors: [
              {
                id: "reasoningEffort",
                options: [{ id: "high", isDefault: true }],
                currentValue: "high",
              },
            ],
          },
        },
        "api-muse-glimmer-30b": {
          capabilities: { inputModalities: ["text", "image"] },
        },
      },
    });
    expect(effective.providers.codex.customModels).toEqual([
      "api-glm-5.3-flash",
      "api-glm-5.3",
      "api-muse-glimmer-30b",
    ]);
    expect(effective.providerInstances[frontierInstanceId]).toMatchObject({
      driver: "codex",
      displayName: "Frontier models",
      enabled: true,
      config: {
        customModels: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "claude-opus-5"],
      },
      environment: [
        { name: "UCSD_AI_BASE_URL", value: managedConfig.provider.baseUrl, sensitive: false },
        {
          name: "TRITONAI_API_KEY_SOURCE",
          value: "TRITONAI_FRONTIER_API_KEY",
          sensitive: false,
        },
      ],
    });
  });

  it("keeps fresh profile homes independent across settings documents", () => {
    const stableHome = "/profiles/stable/codex";
    const nightlyHome = "/profiles/nightly/codex";
    const stable = createManagedProfileSettings(stableHome);
    const nightly = createManagedProfileSettings(nightlyHome);
    const stableSettings = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, managedConfig, {
      rawSettingsDocument: stable,
    });
    const nightlySettings = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, managedConfig, {
      rawSettingsDocument: nightly,
    });
    expect(stableSettings.providers.codex.homePath).toBe(stableHome);
    expect(nightlySettings.providers.codex.homePath).toBe(nightlyHome);
    expect(nightlySettings.providerInstances[frontierInstanceId]?.config).toMatchObject({
      homePath: nightlyHome,
    });
    const missingFile = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, managedConfig, {
      rawSettingsDocument: createManagedProfileSettings("/profiles/third/codex"),
    });
    expect(missingFile.providers.codex.homePath).toBe("/profiles/third/codex");
    expect(missingFile.providers.codex.binaryPath).toBe("codex");
  });

  it("preserves explicit and previously saved Codex homes without moving history", () => {
    for (const savedHome of ["/custom/history", DEFAULT_TRITONAI_CODEX_HOME_PATH]) {
      const migrated = migrateLegacyInstallerManagedSettings({
        providers: { codex: { homePath: savedHome, binaryPath: "/custom/codex" } },
      });
      const effective = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, managedConfig, {
        rawSettingsDocument: migrated.document,
      });
      expect(effective.providers.codex.homePath).toBe(savedHome);
      expect(effective.providers.codex.binaryPath).toBe("/custom/codex");
    }
  });

  it.each([
    ["api-deepseek-v4-flash", "minimal", "high"],
    ["api-deepseek-v4-flash", "medium", "high"],
    ["api-deepseek-v4-flash", "low", "low"],
    ["api-deepseek-v4-flash", "high", "high"],
    ["glm-5.3-flash-test", "medium", "high"],
    ["api-glm-5.3-flash", "max", "high"],
    ["api-glm-5.3-flash", "xhigh", "xhigh"],
    ["api-glm-5.3-flash", "low", "low"],
  ])("normalizes managed reasoning for %s at %s", (model, effort, expected) => {
    const selection = {
      instanceId: managedInstanceId,
      model,
      options: [{ id: "reasoningEffort", value: effort }],
    };
    const effective = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: selection,
      sourceControlWriterModelSelection: selection,
    });
    const expectedSelection = {
      instanceId: managedInstanceId,
      model: "api-glm-5.3-flash",
      options: [{ id: "reasoningEffort", value: expected }],
    };
    expect(effective.textGenerationModelSelection).toEqual(expectedSelection);
    expect(effective.sourceControlWriterModelSelection).toEqual(expectedSelection);
  });

  it("uses defaults only for absent selections and fallbacks for retired selections", () => {
    const retained = applyManagedHarnessPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-terra",
        },
      },
      managedConfig,
      { textGenerationSelectionWasPersisted: true },
    );
    expect(retained.textGenerationModelSelection.model).toBe("gpt-5.6-terra");
    expect(retained.textGenerationModelSelection.instanceId).toBe(frontierInstanceId);

    const absent = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, managedConfig, {
      textGenerationSelectionWasPersisted: false,
    });
    expect(absent.textGenerationModelSelection.model).toBe(managedConfig.models.default);
    expect(absent.textGenerationModelSelection.instanceId).toBe(managedInstanceId);

    const retiredDeepSeek = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: managedInstanceId,
        model: "api-deepseek-v4-flash",
      },
      sourceControlWriterModelSelection: {
        instanceId: managedInstanceId,
        model: "api-deepseek-v4-flash",
      },
    });
    expect(retiredDeepSeek.textGenerationModelSelection.model).toBe("api-glm-5.3-flash");
    expect(retiredDeepSeek.sourceControlWriterModelSelection?.model).toBe("api-glm-5.3-flash");
    expect(retiredDeepSeek.providers.codex.customModels).not.toContain("api-deepseek-v4-flash");

    const retiredGlm = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: managedInstanceId,
        model: "api-glm-5.2",
      },
    });
    expect(retiredGlm.textGenerationModelSelection.model).toBe("api-glm-5.3");
    expect(retiredGlm.textGenerationModelSelection.instanceId).toBe(managedInstanceId);

    const personalGemma = {
      instanceId: ProviderInstanceId.make("personal"),
      model: "api-gemma-4-31b",
    };
    const personalSettings = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: personalGemma,
      sourceControlWriterModelSelection: personalGemma,
    });
    expect(personalSettings.textGenerationModelSelection).toEqual(personalGemma);
    expect(personalSettings.sourceControlWriterModelSelection).toEqual(personalGemma);

    const retiredGemma = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: managedInstanceId,
        model: "api-gemma-4-31b",
      },
    });
    expect(retiredGemma.textGenerationModelSelection.model).toBe("api-muse-glimmer-30b");
    expect(retiredGemma.textGenerationModelSelection.instanceId).toBe(managedInstanceId);

    const renamedGlimmer = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: managedInstanceId,
        model: "onyx-muse-glimmer-30b",
      },
    });
    expect(renamedGlimmer.textGenerationModelSelection.model).toBe("api-muse-glimmer-30b");
    expect(renamedGlimmer.textGenerationModelSelection.instanceId).toBe(managedInstanceId);

    const retiredConfig: TritonAiManagedConfig = {
      ...managedConfig,
      models: {
        ...managedConfig.models,
        replacements: { "retired-model": "gpt-5.6-sol" },
      },
    };
    const retired = applyManagedHarnessPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "retired-model",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      },
      retiredConfig,
    );
    expect(retired.textGenerationModelSelection.model).toBe("gpt-5.6-sol");
    expect(retired.textGenerationModelSelection.instanceId).toBe(frontierInstanceId);
    expect(retired.textGenerationModelSelection.options).toEqual([
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "fast" },
    ]);

    const inheritedKey = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "constructor",
      },
    });
    expect(inheritedKey.textGenerationModelSelection.model).toBe(
      managedConfig.models.restrictedFallback,
    );
    expect(inheritedKey.textGenerationModelSelection.instanceId).toBe(managedInstanceId);
  });

  it("hides routes that have no configured credential", () => {
    const effective = applyManagedHarnessPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          instanceId: frontierInstanceId,
          model: "gpt-5.6-sol",
        },
      },
      managedConfig,
      {
        credentialEnvironment: { TRITONAI_ONPREM_API_KEY: "on-prem-key" },
      },
    );

    expect(effective.providerInstances[managedInstanceId]?.enabled).toBe(true);
    expect(effective.providerInstances[frontierInstanceId]?.enabled).toBe(false);
    expect(effective.providerInstances[frontierInstanceId]?.config).toMatchObject({
      customModels: [],
    });
    expect(effective.textGenerationModelSelection).toMatchObject({
      instanceId: managedInstanceId,
      model: managedConfig.models.restrictedFallback,
    });
  });

  it("disables the managed catalog for an authoritative environment with no credentials", () => {
    const effective = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, managedConfig, {
      credentialEnvironment: {},
    });

    expect(effective.providers.codex.customModels).toEqual([]);
    expect(effective.providerInstances[managedInstanceId]?.enabled).toBe(false);
    expect(effective.providerInstances[frontierInstanceId]?.enabled).toBe(false);
    expect(effective.providerInstances[managedInstanceId]?.config).toMatchObject({
      customModels: [],
    });
    expect(effective.providerInstances[frontierInstanceId]?.config).toMatchObject({
      customModels: [],
    });
  });

  it("removes managed values before persistence without removing user instance fields", () => {
    const effective = applyManagedHarnessPolicy({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [managedInstanceId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "UCSD account",
          config: { launchArgs: "--feature user-choice" },
        },
      },
    });
    const persisted = stripManagedFieldsForPersistence(effective);
    expect(persisted.providers.codex.homePath).toBe("");
    expect(persisted.providerInstances[managedInstanceId]).toMatchObject({
      displayName: "UCSD account",
      config: { launchArgs: "--feature user-choice" },
    });
    expect(persisted.providerInstances[managedInstanceId]?.environment).toBeUndefined();
    expect(persisted.providerInstances[frontierInstanceId]).toBeUndefined();
  });

  it("migrates only the exact legacy default instance and is idempotent", () => {
    const legacy = {
      unknownTopLevel: { keep: true },
      providers: {
        codex: { binaryPath: "/managed/codex", homePath: "/managed/home", userDefined: true },
      },
      providerInstances: {
        codex: {
          driver: "codex",
          config: { binaryPath: "/managed/codex", homePath: "/managed/home", userDefined: true },
          environment: [
            { name: "UCSD_AI_BASE_URL", value: "https://legacy.example.test/v1" },
            { name: "PERSONAL_SETTING", value: "keep" },
          ],
        },
        "codex-personal": { driver: "codex", config: { binaryPath: "/personal/codex" } },
      },
    };

    const first = migrateLegacyInstallerManagedSettings(legacy);
    expect(first.migrated).toBe(true);
    const referenceTarget = (
      first.document as {
        tritonAiManagedPolicy: {
          providerInstanceReferenceRenames: Record<string, string>;
        };
      }
    ).tritonAiManagedPolicy.providerInstanceReferenceRenames.codex_frontier;
    expect(referenceTarget).toMatch(/^codex_frontier_personal_[0-9a-f-]{36}$/);
    expect(first.document).toMatchObject({
      unknownTopLevel: { keep: true },
      providers: { codex: { userDefined: true } },
      providerInstances: {
        codex: {
          config: { userDefined: true },
          environment: [{ name: "PERSONAL_SETTING", value: "keep" }],
        },
        "codex-personal": { driver: "codex", config: { binaryPath: "/personal/codex" } },
      },
      tritonAiManagedPolicy: {
        migrationVersion: 2,
        codexBinaryPath: "/managed/codex",
        codexHomePath: "/managed/home",
        providerInstanceReferenceRenames: {
          codex_frontier: referenceTarget,
        },
      },
    });
    expect(migrateLegacyInstallerManagedSettings(first.document).migrated).toBe(false);
    expect(getManagedProviderInstanceRenames()).toEqual({
      codex_frontier: referenceTarget,
    });
  });

  it("renames a personal instance that collides with the new managed frontier route", () => {
    const personalFrontierInstance = {
      driver: "codex",
      displayName: "My existing frontier setup",
      config: { binaryPath: "/personal/codex", customModels: ["personal-model"] },
      environment: [{ name: "PERSONAL_API_KEY", value: "keep", sensitive: true }],
    };
    const first = migrateLegacyInstallerManagedSettings({
      textGenerationModelSelection: {
        instanceId: "codex_frontier",
        model: "personal-model",
      },
      sourceControlWriterModelSelection: {
        instanceId: "codex_frontier",
        model: "personal-writer-model",
      },
      providerInstances: {
        codex_frontier: personalFrontierInstance,
        codex_frontier_personal: { driver: "codex", displayName: "Already occupied" },
      },
      tritonAiManagedPolicy: {
        migrationVersion: 1,
        codexBinaryPath: "/managed/codex",
        codexHomePath: "/managed/home",
      },
    });

    expect(first.migrated).toBe(true);
    const renamedInstanceId = (
      first.document as {
        tritonAiManagedPolicy: { providerInstanceRenames: Record<string, string> };
      }
    ).tritonAiManagedPolicy.providerInstanceRenames.codex_frontier!;
    expect(renamedInstanceId).toMatch(/^codex_frontier_personal_[0-9a-f-]{36}$/);
    expect(first.document).toMatchObject({
      providerInstances: {
        codex_frontier_personal: { displayName: "Already occupied" },
        [renamedInstanceId]: personalFrontierInstance,
      },
      textGenerationModelSelection: {
        instanceId: renamedInstanceId,
        model: "personal-model",
      },
      sourceControlWriterModelSelection: {
        instanceId: renamedInstanceId,
        model: "personal-writer-model",
      },
      tritonAiManagedPolicy: {
        migrationVersion: 2,
        providerInstanceRenames: { codex_frontier: renamedInstanceId },
        providerInstanceReferenceRenames: {
          codex_frontier: renamedInstanceId,
        },
      },
    });
    expect(
      (first.document as { providerInstances: Record<string, unknown> }).providerInstances
        .codex_frontier,
    ).toBeUndefined();
    expect(migrateLegacyInstallerManagedSettings(first.document).migrated).toBe(false);
    expect(getManagedProviderInstanceRenames()).toEqual({
      codex_frontier: renamedInstanceId,
    });

    const oldMarker = structuredClone(first.document) as {
      tritonAiManagedPolicy: Record<string, unknown>;
    };
    delete oldMarker.tritonAiManagedPolicy.providerInstanceReferenceRenames;
    expect(migrateLegacyInstallerManagedSettings(oldMarker).migrated).toBe(false);
    expect(getManagedProviderInstanceRenames()).toEqual({});

    expect(
      migrateLegacyInstallerManagedSettings({
        tritonAiManagedPolicy: {
          migrationVersion: 2,
          providerInstanceReferenceRenames: {
            codex_frontier: "codex_frontier_personal_10",
          },
        },
      }).migrated,
    ).toBe(false);
    expect(getManagedProviderInstanceRenames()).toEqual({
      codex_frontier: "codex_frontier_personal_10",
    });
  });
});
