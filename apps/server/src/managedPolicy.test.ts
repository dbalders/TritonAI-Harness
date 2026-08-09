import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TRITONAI_CODEX_HOME_PATH,
  ProviderDriverKind,
  ProviderInstanceId,
  type TritonAiManagedConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyManagedHarnessPolicy,
  managedConfig,
  migrateLegacyInstallerManagedSettings,
  stripManagedFieldsForPersistence,
  validateBundledManagedConfig,
} from "./managedPolicy.ts";

const managedInstanceId = ProviderInstanceId.make("codex");

describe("TritonAI managed Harness policy", () => {
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
    ]);
  });

  it("uses defaults only for absent selections and fallbacks for retired selections", () => {
    const retained = applyManagedHarnessPolicy(
      {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: { instanceId: "codex" as never, model: "gpt-5.6-terra" },
      },
      managedConfig,
      { textGenerationSelectionWasPersisted: true },
    );
    expect(retained.textGenerationModelSelection.model).toBe("gpt-5.6-terra");

    const absent = applyManagedHarnessPolicy(DEFAULT_SERVER_SETTINGS, managedConfig, {
      textGenerationSelectionWasPersisted: false,
    });
    expect(absent.textGenerationModelSelection.model).toBe(managedConfig.models.default);

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
        textGenerationModelSelection: { instanceId: "codex" as never, model: "retired-model" },
      },
      retiredConfig,
    );
    expect(retired.textGenerationModelSelection.model).toBe("gpt-5.6-sol");
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
        migrationVersion: 1,
        codexBinaryPath: "/managed/codex",
        codexHomePath: "/managed/home",
      },
    });
    expect(migrateLegacyInstallerManagedSettings(first.document).migrated).toBe(false);
  });
});
