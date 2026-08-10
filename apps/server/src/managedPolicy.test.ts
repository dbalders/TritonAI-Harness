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
      customModels: ["api-deepseek-v4-flash", "api-glm-5.2", "api-gemma-4-31b"],
    });
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
        },
      },
      retiredConfig,
    );
    expect(retired.textGenerationModelSelection.model).toBe("gpt-5.6-sol");
    expect(retired.textGenerationModelSelection.instanceId).toBe(frontierInstanceId);

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
      },
    });
    expect(migrateLegacyInstallerManagedSettings(first.document).migrated).toBe(false);
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
    expect(first.document).toMatchObject({
      providerInstances: {
        codex_frontier_personal: { displayName: "Already occupied" },
        codex_frontier_personal_2: personalFrontierInstance,
      },
      textGenerationModelSelection: {
        instanceId: "codex_frontier_personal_2",
        model: "personal-model",
      },
      sourceControlWriterModelSelection: {
        instanceId: "codex_frontier_personal_2",
        model: "personal-writer-model",
      },
      tritonAiManagedPolicy: {
        migrationVersion: 2,
        providerInstanceRenames: { codex_frontier: "codex_frontier_personal_2" },
      },
    });
    expect(
      (first.document as { providerInstances: Record<string, unknown> }).providerInstances
        .codex_frontier,
    ).toBeUndefined();
    expect(migrateLegacyInstallerManagedSettings(first.document).migrated).toBe(false);
  });
});
