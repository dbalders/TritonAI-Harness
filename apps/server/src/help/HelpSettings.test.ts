import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  HelpSettingsSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  UsageLimitSourceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { buildHelpPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { helpSettingsSnapshot } from "./HelpSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";

const providerId = ProviderInstanceId.make("test-provider");
const isHelpSettingsSnapshot = Schema.is(HelpSettingsSnapshot);
const values = (snapshot: ReturnType<typeof helpSettingsSnapshot>) =>
  Object.fromEntries(snapshot.entries.map((entry) => [entry.key, entry.value]));

const promptForSnapshot = (snapshot: ReturnType<typeof helpSettingsSnapshot>) => {
  return buildHelpPrompt({
    messages: [{ role: "user", content: "Show my actual provider and source-control settings" }],
    context: {
      capturedAt: "2026-10-22T12:00:00.000Z",
      environmentId: EnvironmentId.make("help-test"),
      environmentName: "Test host",
      version: "test",
      platform: "darwin",
      mode: "local",
      paths: [],
      providers: [],
      modelLabel: "Test model",
      knowledge: {
        settings: snapshot,
        pluginsStatus: "reported",
        plugins: [],
        pluginsOmittedCount: 0,
        documentationStatus: "available",
        documentation: [],
      },
      diagnostics: {
        recordCount: 0,
        failureCount: 0,
        slowSpanCount: 0,
        partial: false,
        recentFailures: [],
      },
    },
  }).prompt;
};

describe("Help settings snapshot", () => {
  it("extracts nested current values generically and distinguishes effective policy from saved choices", () => {
    const configured: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAgentDeviceAccess: false,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        overrides: { pauseWhenOnBattery: true },
      },
      automaticGitFetchInterval: Duration.seconds(75),
      providerInstances: {
        [providerId]: {
          driver: ProviderDriverKind.make("codex"),
          config: {
            enabled: true,
            customModels: ["exact-custom-model"],
            nestedFutureSetting: { mode: "precise", flag: false },
          },
        },
      },
    };
    const effective = { ...configured, enableAgentDeviceAccess: true };
    const snapshot = helpSettingsSnapshot(effective, configured);
    const result = values(snapshot);
    expect(result.enableAgentDeviceAccess).toBe("true");
    expect(result["configured.enableAgentDeviceAccess"]).toBe("false");
    expect(result["backgroundActivity.overrides.pauseWhenOnBattery"]).toBe("true");
    expect(result.automaticGitFetchInterval).toBe("75000 ms");
    expect(result[`providerInstances.${providerId}.config.customModels[0]`]).toBe(
      "exact-custom-model",
    );
    expect(
      result[`providerInstances.${providerId}.config.nestedFutureSetting.flag`],
    ).toBeUndefined();
    expect(result[`providerInstances.${providerId}.config.$omitted`]).toContain(
      "undeclared provider fields omitted",
    );
    expect(isHelpSettingsSnapshot(snapshot)).toBe(true);
  });

  it("uses schema secret redaction and presence markers, including environment and per-host credentials", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [providerId]: {
          driver: ProviderDriverKind.make("antigravity"),
          config: {
            apiKey: "opaque-google-key",
            authMethod: "api-key",
            clientSecret: "opaque-unknown-secret",
            nested: { password: "opaque-password" },
          },
          environment: [
            { name: "PRIVATE_VALUE", value: "opaque-env", sensitive: true },
            { name: "API_TOKEN", value: "opaque-token", sensitive: false },
            { name: "EMPTY_API_TOKEN", value: "", sensitive: true },
          ],
        },
        [ProviderInstanceId.make("empty")]: {
          driver: ProviderDriverKind.make("antigravity"),
          config: { apiKey: "" },
        },
        [ProviderInstanceId.make("redacted")]: {
          driver: ProviderDriverKind.make("antigravity"),
          config: { apiKey: SECRET_REDACTED },
          environment: [{ name: "PRIVATE_VALUE", value: "", sensitive: true, valueRedacted: true }],
        },
      },
      usageLimitSources: {
        [UsageLimitSourceId.make("hub")]: {
          kind: "cliproxy",
          url: "https://quota.example",
          managementKey: "opaque-management",
          enabled: true,
        },
      },
      sourceControlHosts: {
        github: { tokens: { "github.com": "opaque-github", "empty.test": "" } },
      },
    };
    const snapshot = helpSettingsSnapshot(settings, settings);
    const json = JSON.stringify(snapshot);
    for (const secret of [
      "opaque-google-key",
      "opaque-env",
      "opaque-token",
      "opaque-management",
      "opaque-github",
      "opaque-unknown-secret",
      "opaque-password",
    ])
      expect(json).not.toContain(secret);
    const result = values(snapshot);
    expect(result[`providerInstances.${providerId}.config.apiKey`]).toBe("configured");
    expect(result["providerInstances.empty.config.apiKey"]).toBe("missing");
    expect(result["providerInstances.redacted.config.apiKey"]).toBe("configured");
    expect(result["providerInstances.redacted.environment[0].value"]).toBe("configured");
    expect(result[`providerInstances.${providerId}.environment[2].value`]).toBe("missing");
    expect(result["sourceControlHosts.github.tokens.github.com"]).toBe("configured");
    expect(result["sourceControlHosts.github.tokens.empty.test"]).toBe("missing");
    expect(
      snapshot.entries.find((entry) => entry.key === "providerInstances.empty.config.apiKey")
        ?.configured,
    ).toBe(false);
  });

  it("never flattens opaque provider config or credential-bearing arrays and objects", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("future")]: {
          driver: ProviderDriverKind.make("future-driver"),
          config: {
            headers: { Authorization: ["synthetic-credential"] },
            unknown: { value: "opaque-private-value" },
          },
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: {
            headers: { Authorization: ["known-driver-credential"] },
            nestedFutureSetting: { flag: false, anything: "undeclared-private-value" },
            enabled: true,
          },
        },
      },
      sourceControlHosts: {
        "future.host": { config: { data: ["opaque-dotted-host-value"] } },
        future: {
          authorization: ["array-credential"],
          clientSecret: { value: "object-credential" },
          headers: { oddName: "header-credential" },
          innocentObject: { data: ["opaque-host-credential"] },
        },
      },
    };
    const snapshot = helpSettingsSnapshot(settings, settings, "What are my provider settings?");
    const json = JSON.stringify(snapshot);
    for (const secret of [
      "synthetic-credential",
      "opaque-private-value",
      "known-driver-credential",
      "undeclared-private-value",
      "array-credential",
      "object-credential",
      "header-credential",
      "opaque-host-credential",
      "opaque-dotted-host-value",
    ])
      expect(json).not.toContain(secret);
    expect(values(snapshot)["providerInstances.future.config"]).toContain(
      "opaque provider configuration omitted",
    );
    expect(values(snapshot)["providerInstances.codex.config.enabled"]).toBe("true");
    expect(values(snapshot)["sourceControlHosts.future"]).toContain(
      "opaque source-control configuration omitted",
    );
  });

  it("filters declared provider arrays and source-control records recursively before snapshot and prompt extraction", () => {
    const config = {
      enabled: true,
      binaryPath: "",
      customModels: [
        {
          slug: "model",
          proxy: { auth: ["synthetic-nested-credential"] },
          capabilities: {
            inputModalities: ["text", "image"],
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "high", label: "High", proxy: { auth: ["synthetic-option-private"] } },
                ],
              },
            ],
            opaque: { data: ["synthetic-capabilities-private"] },
          },
        },
      ],
      customModelMetadata: {
        model: {
          name: "Declared model name",
          capabilities: { inputModalities: ["text"] },
          innocent: { data: "synthetic-metadata-private" },
        },
      },
    };
    const configured: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: { driver: ProviderDriverKind.make("codex"), config },
        [ProviderInstanceId.make("antigravity")]: {
          driver: ProviderDriverKind.make("antigravity"),
          config: { apiKey: "synthetic-provider-credential" },
        },
      },
      sourceControlHosts: {
        github: {
          hosts: {
            "github.com": {
              account: "declared-account",
              enabled: false,
              innocent: { data: ["synthetic-host-private"] },
            },
          },
          tokens: { "github.com": "synthetic-host-token" },
        },
      },
    };
    const effective: ServerSettings = {
      ...configured,
      providerInstances: {
        ...configured.providerInstances,
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { ...config, enabled: false, binaryPath: "codex" },
        },
        [ProviderInstanceId.make("antigravity")]: {
          driver: ProviderDriverKind.make("antigravity"),
          config: { apiKey: "" },
        },
      },
      sourceControlHosts: {
        github: {
          ...configured.sourceControlHosts.github,
          hosts: { "github.com": { enabled: true } },
          tokens: { "github.com": "" },
        },
      },
    };
    const snapshot = helpSettingsSnapshot(effective, configured);
    const result = values(snapshot);
    const prompt = promptForSnapshot(snapshot);
    for (const output of [JSON.stringify(snapshot), prompt]) {
      for (const privateValue of [
        "synthetic-nested-credential",
        "synthetic-capabilities-private",
        "synthetic-option-private",
        "synthetic-metadata-private",
        "synthetic-host-private",
        "synthetic-provider-credential",
        "synthetic-host-token",
      ])
        expect(output).not.toContain(privateValue);
    }
    expect(prompt).toContain("providerInstances.codex.config.customModels[0].slug");
    expect(prompt).toContain("Declared model name");
    expect(result["providerInstances.codex.config.customModels[0].slug"]).toBe("model");
    expect(
      result["providerInstances.codex.config.customModels[0].capabilities.inputModalities[1]"],
    ).toBe("image");
    expect(result["providerInstances.codex.config.customModelMetadata.model.name"]).toBe(
      "Declared model name",
    );
    expect(result["providerInstances.codex.config.enabled"]).toBe("false");
    expect(result["configured.providerInstances.codex.config.enabled"]).toBe("true");
    expect(result["sourceControlHosts.github.hosts.github.com.enabled"]).toBe("true");
    expect(result["configured.sourceControlHosts.github.hosts.github.com.enabled"]).toBe("false");
    expect(result["configured.sourceControlHosts.github.hosts.github.com.account"]).toBe(
      "declared-account",
    );
    for (const key of [
      "providerInstances.antigravity.config.apiKey",
      "sourceControlHosts.github.tokens.github.com",
    ]) {
      expect(snapshot.entries.find((entry) => entry.key === key)).toMatchObject({
        value: "missing",
        configured: false,
      });
      expect(snapshot.entries.find((entry) => entry.key === `configured.${key}`)).toMatchObject({
        value: "configured",
        configured: true,
      });
    }
    expect(result["providerInstances.codex.config.binaryPath"]).toBe("codex");
    expect(result["configured.providerInstances.codex.config.binaryPath"]).toBe("");
    expect(result["providerInstances.codex.config.homePath"]).toBeUndefined();
    expect(isHelpSettingsSnapshot(snapshot)).toBe(true);
  });

  it("omits incompatible values under declared fields without exposing raw children", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [providerId]: {
          driver: ProviderDriverKind.make("codex"),
          config: {
            enabled: { data: ["synthetic-boolean-private"] },
            customModels: [{ slug: { data: ["synthetic-slug-private"] } }],
          },
        },
      },
      sourceControlHosts: {
        github: { hosts: { "github.com": { account: { data: "synthetic-account-private" } } } },
      },
    };
    const snapshot = helpSettingsSnapshot(settings, settings);
    const result = values(snapshot);
    for (const output of [JSON.stringify(snapshot), promptForSnapshot(snapshot)]) {
      for (const value of [
        "synthetic-boolean-private",
        "synthetic-slug-private",
        "synthetic-account-private",
      ])
        expect(output).not.toContain(value);
    }
    for (const key of [
      `providerInstances.${providerId}.config.enabled`,
      `providerInstances.${providerId}.config.customModels`,
      "sourceControlHosts.github.hosts",
    ])
      expect(result[key]).toBe("[unrecognized setting value omitted]");
    expect(snapshot.omittedCount).toBeGreaterThanOrEqual(3);
  });

  it("summarizes unrelated project overrides and executable content without exposing identities or prompts", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [ProjectId.make("other-private-project")]: {
          reviewGuideInstructions: "private project prompt",
          enableAgentBrowserAccess: false,
        },
      },
      projectScriptOverrides: {
        [ProjectId.make("other-private-project")]: [
          {
            id: "private",
            name: "private-script",
            command: "printf opaque-script-secret",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
      },
      reviewGuideInstructions: "Global review preference",
    };
    const snapshot = helpSettingsSnapshot(settings, settings);
    const json = JSON.stringify(snapshot);
    for (const value of [
      "other-private-project",
      "private project prompt",
      "opaque-script-secret",
      "Global review preference",
    ])
      expect(json).not.toContain(value);
    expect(values(snapshot).projectSettingsOverrides).toContain("1 project override records");
    expect(
      values(helpSettingsSnapshot(settings, settings, "Show my reviewGuideInstructions"))
        .reviewGuideInstructions,
    ).toBe("Global review preference");
  });

  it("keeps requested exact values after large maps and reports record and value omission", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      usageModelAliases: Object.fromEntries(
        Array.from({ length: 1_200 }, (_, index) => [
          `custom-model-${index}`,
          `priced-model-${index}`,
        ]),
      ),
      branchNamePrefix: "a".repeat(2_000),
    };
    const snapshot = helpSettingsSnapshot(
      settings,
      settings,
      "What is usageModelAliases custom-model-1199 and branchNamePrefix?",
    );
    const result = values(snapshot);
    expect(result["usageModelAliases.custom-model-1199"]).toBe("priced-model-1199");
    expect(result.branchNamePrefix).toBe("a".repeat(2_000));
    expect(snapshot.entries).toHaveLength(300);
    expect(snapshot.omittedCount).toBe(snapshot.totalCount - snapshot.entries.length);
    expect(snapshot.omittedCount).toBeGreaterThan(0);
    expect(values(helpSettingsSnapshot(settings, undefined)).branchNamePrefix).toContain(
      "truncated",
    );
    expect(isHelpSettingsSnapshot(snapshot)).toBe(true);
  });
});
