import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TRITONAI_CODEX_HOME_PATH,
  ProjectId,
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
  migrateManagedNewThreadDefaults,
  stripManagedFieldsForPersistence,
  validateBundledManagedConfig,
} from "./managedPolicy.ts";

const managedInstanceId = ProviderInstanceId.make("codex");
const frontierInstanceId = ProviderInstanceId.make("codex_frontier");

const primaryCapabilities = {
  inputModalities: ["text", "image"],
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High", isDefault: true },
        { id: "xhigh", label: "Extra High" },
      ],
      currentValue: "high",
    },
  ],
} as const;
const fixtureConfig: TritonAiManagedConfig = {
  ...managedConfig,
  models: {
    default: "on-prem-primary",
    restrictedFallback: "on-prem-fallback",
    replacements: {
      "retired-primary": "on-prem-primary",
      "retired-cloud": "cloud-primary",
    },
    catalog: [
      {
        id: "on-prem-primary",
        name: "Primary",
        shortName: "Primary",
        route: "on-prem",
        capabilities: primaryCapabilities,
      },
      {
        id: "on-prem-fallback",
        name: "Fallback",
        route: "on-prem",
        capabilities: { inputModalities: ["text"] },
      },
      { id: "cloud-primary", name: "Cloud", route: "frontier" },
    ],
  },
};

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

  it("locks managed fields and separates route catalogs while preserving user fields", () => {
    const effective = applyManagedHarnessPolicy(
      {
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
      },
      fixtureConfig,
    );
    expect(effective.providers.codex).toMatchObject({
      binaryPath: "codex",
      homePath: DEFAULT_TRITONAI_CODEX_HOME_PATH,
      customModels: ["on-prem-primary", "on-prem-fallback"],
    });
    expect(effective.providerInstances[managedInstanceId]).toMatchObject({
      driver: "codex",
      enabled: true,
      config: {
        binaryPath: "codex",
        homePath: DEFAULT_TRITONAI_CODEX_HOME_PATH,
        userDefined: true,
        customModels: ["on-prem-primary", "on-prem-fallback"],
        customModelMetadata: {
          "on-prem-primary": {
            name: "Primary",
            shortName: "Primary",
            capabilities: primaryCapabilities,
          },
        },
      },
    });
    expect(effective.providerInstances[managedInstanceId]?.environment).toEqual([
      { name: "USER_SETTING", value: "preserved", sensitive: false },
      { name: "UCSD_AI_BASE_URL", value: fixtureConfig.provider.baseUrl, sensitive: false },
      { name: "TRITONAI_API_KEY_SOURCE", value: "TRITONAI_ONPREM_API_KEY", sensitive: false },
    ]);
    expect(effective.providerInstances[frontierInstanceId]).toMatchObject({
      driver: "codex",
      enabled: true,
      config: { customModels: ["cloud-primary"] },
      environment: [
        { name: "UCSD_AI_BASE_URL", value: fixtureConfig.provider.baseUrl, sensitive: false },
        { name: "TRITONAI_API_KEY_SOURCE", value: "TRITONAI_FRONTIER_API_KEY", sensitive: false },
      ],
    });
  });

  it("uses Flash for new tasks on profiles without an explicit default", () => {
    const effective = migrateManagedNewThreadDefaults(DEFAULT_SERVER_SETTINGS, {}).settings;
    expect(effective.defaultModelSelection).toEqual({
      instanceId: managedInstanceId,
      model: "api-glm-5.3-flash",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  it("resets app and project defaults once while preserving later choices", () => {
    const sol = { instanceId: frontierInstanceId, model: "gpt-6.1-sol" };
    const first = migrateManagedNewThreadDefaults(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: sol,
        projectSettingsOverrides: {
          [ProjectId.make("project")]: {
            defaultModelSelection: sol,
            defaultRuntimeMode: "approval-required",
          },
        },
      },
      { tritonAiManagedPolicy: { migrationVersion: 2, codexHomePath: "/kept/home" } },
    );
    expect(first.settings.defaultModelSelection?.model).toBe("api-glm-5.3-flash");
    expect(first.settings.projectSettingsOverrides).toEqual({
      project: { defaultRuntimeMode: "approval-required" },
    });
    expect(first.document).toEqual({
      tritonAiManagedPolicy: {
        migrationVersion: 2,
        codexHomePath: "/kept/home",
        newThreadDefaultsVersion: 1,
      },
    });
    const changed = { ...first.settings, defaultModelSelection: sol };
    expect(migrateManagedNewThreadDefaults(changed, first.document)).toEqual({
      settings: changed,
      document: first.document,
      migrated: false,
    });
  });

  it("preserves explicit defaults and upgrades retired managed defaults", () => {
    const personalDefault = {
      instanceId: ProviderInstanceId.make("personal"),
      model: "personal-model",
    };
    expect(
      applyManagedHarnessPolicy({
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: personalDefault,
      }).defaultModelSelection,
    ).toEqual(personalDefault);
    expect(
      applyManagedHarnessPolicy({
        ...DEFAULT_SERVER_SETTINGS,
        defaultModelSelection: { instanceId: managedInstanceId, model: "claude-opus-5" },
      }).defaultModelSelection,
    ).toEqual({ instanceId: frontierInstanceId, model: "claude-opus-5-5" });
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

  it("anchors an unsaved Codex home to the profile's own directory, not production", () => {
    const migrated = migrateLegacyInstallerManagedSettings(
      { providers: { codex: { binaryPath: "codex" } } },
      { defaultCodexHomePath: "/profiles/nightly/codex" },
    );
    expect(migrated.migrated).toBe(true);
    expect(migrated.document).toMatchObject({
      tritonAiManagedPolicy: { codexHomePath: "/profiles/nightly/codex" },
    });
    const effective = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, managedConfig, {
      rawSettingsDocument: migrated.document,
    });
    expect(effective.providers.codex.homePath).toBe("/profiles/nightly/codex");

    // A stamped marker keeps its home even when the profile default differs.
    const stamped = migrateLegacyInstallerManagedSettings(migrated.document, {
      defaultCodexHomePath: "/profiles/other/codex",
    });
    expect(stamped.migrated).toBe(false);
    expect(stamped.document).toBe(migrated.document);
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
    ["retired-primary", "minimal", "high"],
    ["retired-primary", "medium", "high"],
    ["on-prem-primary", "max", "high"],
    ["on-prem-primary", "low", "low"],
    ["on-prem-primary", "xhigh", "xhigh"],
  ])("normalizes managed reasoning for %s at %s", (model, effort, expected) => {
    const selection = {
      instanceId: managedInstanceId,
      model,
      options: [{ id: "reasoningEffort", value: effort }],
    };
    const effective = applyManagedHarnessPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: selection,
        sourceControlWriterModelSelection: selection,
      },
      fixtureConfig,
    );
    const expectedSelection = {
      instanceId: managedInstanceId,
      model: "on-prem-primary",
      options: [{ id: "reasoningEffort", value: expected }],
    };
    expect(effective.textGenerationModelSelection).toEqual(expectedSelection);
    expect(effective.sourceControlWriterModelSelection).toEqual(expectedSelection);
  });

  it("uses defaults for absent selections, replacements for retired models, and fallbacks for unknown models", () => {
    const absent = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, fixtureConfig, {
      textGenerationSelectionWasPersisted: false,
    });
    expect(absent.textGenerationModelSelection).toMatchObject({
      model: "on-prem-primary",
      instanceId: managedInstanceId,
    });

    for (const [model, expectedModel, expectedInstance] of [
      ["cloud-primary", "cloud-primary", frontierInstanceId],
      ["retired-cloud", "cloud-primary", frontierInstanceId],
      ["retired-primary", "on-prem-primary", managedInstanceId],
      ["unknown-model", "on-prem-fallback", managedInstanceId],
      ["constructor", "on-prem-fallback", managedInstanceId],
    ] as const) {
      const selection = { instanceId: managedInstanceId, model };
      const effective = applyManagedHarnessPolicy(
        {
          ...DEFAULT_SERVER_SETTINGS,
          textGenerationModelSelection: selection,
          sourceControlWriterModelSelection: selection,
        },
        fixtureConfig,
      );
      const expected = { model: expectedModel, instanceId: expectedInstance };
      expect(effective.textGenerationModelSelection).toMatchObject(expected);
      expect(effective.sourceControlWriterModelSelection).toMatchObject(expected);
    }

    const personal = { instanceId: ProviderInstanceId.make("personal"), model: "retired-primary" };
    const personalSettings = applyManagedHarnessPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: personal,
        sourceControlWriterModelSelection: personal,
      },
      fixtureConfig,
    );
    expect(personalSettings.textGenerationModelSelection).toEqual(personal);
    expect(personalSettings.sourceControlWriterModelSelection).toEqual(personal);

    const options = [
      { id: "reasoningEffort", value: "xhigh" },
      { id: "serviceTier", value: "fast" },
    ];
    const retired = applyManagedHarnessPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          instanceId: managedInstanceId,
          model: "retired-cloud",
          options,
        },
      },
      fixtureConfig,
    );
    expect(retired.textGenerationModelSelection).toEqual({
      model: "cloud-primary",
      instanceId: frontierInstanceId,
      options,
    });
  });

  it("hides routes that have no configured credential", () => {
    const effective = applyManagedHarnessPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: {
          instanceId: frontierInstanceId,
          model: "cloud-primary",
        },
      },
      fixtureConfig,
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
      model: fixtureConfig.models.restrictedFallback,
    });
  });

  it("disables the managed catalog for an authoritative environment with no credentials", () => {
    const effective = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, fixtureConfig, {
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
