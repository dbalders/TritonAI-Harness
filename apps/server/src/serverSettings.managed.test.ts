import { describe } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_TRITONAI_CODEX_MODEL,
  DEFAULT_TRITONAI_CODEX_HOME_PATH,
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { getManagedCodexSettings, getManagedProviderInstanceRenames } from "./managedPolicy.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const providerEnvironmentSecretName = (instanceId: string, name: string): string =>
  `provider-env-${Buffer.from(instanceId, "utf8").toString("base64url")}-${Buffer.from(name, "utf8").toString("base64url")}`;

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layerUnmanagedTest.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

const makeInspectableServerSettingsLayer = () =>
  ServerSettingsModule.layerUnmanagedTest.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-inspectable-test-",
        }),
      ),
    ),
  );

const makeManagedServerSettingsLayer = () =>
  ServerSettingsModule.layerManagedTest({ TRITONAI_API_KEY: "managed-test-key" }).pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "tritonai-managed-server-settings-test-",
        }),
      ),
    ),
  );

const makeFailingSecretStoreLayer = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });

it.layer(NodeServices.layer)("managed server settings", (it) => {
  it.effect("keeps managed policy on a settings stream when a secret read fails", () =>
    Effect.gen(function* () {
      const original = yield* ServerSecretStore.ServerSecretStore;
      let failReads = false;
      const failing = {
        ...original,
        get: (name: string) =>
          failReads
            ? Effect.fail(
                new ServerSecretStore.SecretStoreReadError({
                  resource: "fixture secret",
                  cause: new Error("fixture failure"),
                }),
              )
            : original.get(name),
      };
      const context = yield* Layer.build(
        ServerSettingsModule.layerManagedTest({ TRITONAI_API_KEY: "managed-test-key" }).pipe(
          Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, failing)),
        ),
      );
      const settings = Context.get(context, ServerSettingsModule.ServerSettingsService);
      const before = yield* settings.getSettings;
      const changes = yield* settings.subscribeChanges;
      yield* settings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("codex-personal-fixture")]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            config: {},
            environment: [{ name: "FIXTURE_TOKEN", value: "fixture-only", sensitive: true }],
          },
        },
      });
      failReads = true;
      const event = yield* Stream.runHead(changes);
      assert.isTrue(Option.isSome(event));
      if (Option.isNone(event)) return;
      assert.equal(
        getManagedCodexSettings(event.value).binaryPath,
        getManagedCodexSettings(before).binaryPath,
      );
      assert.equal(
        getManagedCodexSettings(event.value).homePath,
        getManagedCodexSettings(before).homePath,
      );
      assert.equal(event.value.providerInstances[ProviderInstanceId.make("codex")]?.enabled, true);
      assert.isAbove(getManagedCodexSettings(event.value).customModels.length, 0);
    }).pipe(Effect.scoped, Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("starts a fresh managed installation in Auto mode", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const settings = yield* serverSettings.getSettings;

      assert.equal(settings.defaultRuntimeMode, "auto");
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  describe.each(
    Array.from(
      ["approval-required", "auto-accept-edits", "auto", "full-access"] as const,
      (scenario) => ({ scenario }),
    ),
  )("case $scenario", ({ scenario: defaultRuntimeMode }) => {
    it.effect(`preserves the ${defaultRuntimeMode} default and project override after reload`, () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const projectId = ProjectId.make("permission-preference-project");
        yield* serverSettings.updateSettings({
          defaultRuntimeMode,
          projectSettingsOverrides: { [projectId]: { defaultRuntimeMode } },
        });

        const reloaded = yield* Effect.gen(function* () {
          const fresh = yield* ServerSettingsModule.ServerSettingsService;
          return yield* fresh.getSettings;
        }).pipe(
          Effect.provide(
            Layer.fresh(
              ServerSettingsModule.layerManagedTest({ TRITONAI_API_KEY: "managed-test-key" }),
            ),
          ),
        );

        assert.equal(reloaded.defaultRuntimeMode, defaultRuntimeMode);
        assert.equal(
          reloaded.projectSettingsOverrides[projectId]?.defaultRuntimeMode,
          defaultRuntimeMode,
        );
      }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
    );
  });

  it.effect("turns Memory on for a new installation and keeps it on after reload", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      assert.isTrue((yield* serverSettings.getSettings).memoryEnabled);

      assert.isTrue(yield* fileSystem.exists(serverConfig.settingsPath));
      yield* serverSettings.start;
      assert.isTrue((yield* serverSettings.getSettings).memoryEnabled);
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("turns Memory on for an installation with threads but no settings file", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-08-25T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project-1', 'Acme App', '/code/acme', '[]', ${createdAt}, ${createdAt})
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('thread-1', 'project-1', 'Earlier work', ${createdAt}, ${createdAt})
      `;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* serverSettings.start;

      assert.isTrue((yield* serverSettings.getSettings).memoryEnabled);
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("turns Memory on for an existing installation that never chose", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        encodeUnknownJson({ addProjectBaseDirectory: "~/Development" }),
      );
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* serverSettings.start;

      const settings = yield* serverSettings.getSettings;
      assert.isTrue(settings.memoryEnabled);
      assert.equal(settings.addProjectBaseDirectory, "~/Development");
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("keeps an explicit Memory off choice through other settings changes and reload", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        encodeUnknownJson({ memoryEnabled: false }),
      );
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* serverSettings.start;

      assert.isFalse((yield* serverSettings.getSettings).memoryEnabled);
      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/Development" });
      yield* serverSettings.start;
      assert.isFalse((yield* serverSettings.getSettings).memoryEnabled);

      const persisted = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.include(persisted, '"memoryEnabled": false');
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("folds a legacy in-config enabled flag into the envelope on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable sticks.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"grok":{"driver":"grok","enabled":true,"config":{"enabled":false}},"codex_work":{"driver":"codex","config":{"enabled":true,"homePath":"~/.codex"}},"cursor":{"driver":"cursor","config":{"enabled":"nope"}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      const grokId = ProviderInstanceId.make("grok");
      const codexWorkId = ProviderInstanceId.make("codex_work");
      assert.deepEqual(settings.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: {},
      });
      // A lone in-config flag is lifted to the envelope and stripped.
      assert.deepEqual(settings.providerInstances[codexWorkId], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: "~/.codex" },
      });
      // A malformed flag is left alone so driver schema validation can
      // surface it instead of the fold silently repairing the config.
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: "nope" },
      });
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("folds in-config enabled flags arriving through updates", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const grokId = ProviderInstanceId.make("grok");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make("grok"),
            enabled: true,
            config: { enabled: false, binaryPath: "/opt/grok" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  // Pre-marker builds ran an unsaved Codex home at the profile's own
  // `<baseDir>/codex`; the anchor must land there so a nightly or dev profile
  // keeps its history instead of moving onto the production home.
  describe.each(
    Array.from(
      [
        ["empty", "{}"],
        ["legacy", '{"addProjectBaseDirectory":"~/ExistingProjects"}'],
        ["malformed", "{invalid"],
        ["non-object", "null"],
      ] as const,
      (scenario) => ({ scenario }),
    ),
  )("case $scenario", ({ scenario: [label, document] }) => {
    it.effect(`preserves the profile's Codex home for an existing ${label} settings file`, () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        yield* fs.writeFileString(config.settingsPath, document);
        const effective = yield* settings.getSettings;
        const profileHome = path.join(config.baseDir, "codex");
        assert.equal(getManagedCodexSettings(effective).homePath, profileHome);
        assert.deepInclude(
          effective.providerInstances[ProviderInstanceId.make("codex_frontier")]?.config,
          { homePath: profileHome },
        );
      }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
    );
  });

  it.effect("keeps the production Codex home for a stamped marker without one", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"tritonAiManagedPolicy":{"migrationVersion":2}}',
      );
      const effective = yield* settings.getSettings;
      assert.equal(getManagedCodexSettings(effective).homePath, DEFAULT_TRITONAI_CODEX_HOME_PATH);
      assert.deepInclude(
        effective.providerInstances[ProviderInstanceId.make("codex_frontier")]?.config,
        { homePath: DEFAULT_TRITONAI_CODEX_HOME_PATH },
      );
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("preserves the historical Codex home when only conversation history exists", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      assert.isFalse(yield* fs.exists(config.settingsPath));
      yield* recordProviderUsage("codex", "codex_frontier");
      assert.equal(
        getManagedCodexSettings(yield* settings.getSettings).homePath,
        DEFAULT_TRITONAI_CODEX_HOME_PATH,
      );
      assert.deepEqual(getManagedProviderInstanceRenames(), {});
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect(
    "retains a new profile's Codex home after conversations, settings saves and reopening",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const expectedHome = path.join(config.baseDir, "codex");
        assert.isFalse(yield* fs.exists(config.settingsPath));
        assert.equal(getManagedCodexSettings(yield* settings.getSettings).homePath, expectedHome);
        assert.isTrue(yield* fs.exists(config.settingsPath));
        yield* recordProviderUsage("codex");
        const reopen = Effect.gen(function* () {
          const freshSettings = yield* ServerSettingsModule.ServerSettingsService;
          return yield* freshSettings.getSettings;
        }).pipe(
          Effect.provide(
            Layer.fresh(
              ServerSettingsModule.layerManagedTest({ TRITONAI_API_KEY: "managed-test-key" }),
            ),
          ),
        );
        assert.equal(getManagedCodexSettings(yield* reopen).homePath, expectedHome);
        yield* settings.updateSettings({ addProjectBaseDirectory: "~/NewProjects" });
        const reopened = yield* reopen;
        assert.equal(getManagedCodexSettings(reopened).homePath, expectedHome);
        assert.equal(reopened.addProjectBaseDirectory, "~/NewProjects");
      }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect(
    "resets legacy app and project model defaults once and preserves subsequent choices",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const sol = createModelSelection(ProviderInstanceId.make("codex_frontier"), "gpt-6.1-sol");
        const projectId = ProjectId.make("legacy-sol-project");
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          default_thread_env_mode, auto_pull, scripts_json, created_at, updated_at
        ) VALUES (
          ${projectId}, ${"Legacy Sol"}, ${"/tmp/legacy-sol"}, ${encodeUnknownJson(sol)},
          ${"worktree"}, ${1}, ${"[]"},
          ${"2026-10-01T00:00:00.000Z"}, ${"2026-10-01T00:00:00.000Z"}
        )
      `;
        yield* fs.writeFileString(
          config.settingsPath,
          encodeUnknownJson({
            tritonAiManagedPolicy: { migrationVersion: 2 },
            defaultModelSelection: sol,
            projectSettingsOverrides: {
              explicit: { defaultModelSelection: sol, defaultAutoPull: true },
            },
          }),
        );
        const reset = yield* settings.getSettings;
        assert.equal(reset.defaultModelSelection?.model, "api-glm-5.3-flash");
        assert.isTrue(reset.projectSettingsFolded);
        assert.deepEqual(reset.projectSettingsOverrides, {
          [ProjectId.make("explicit")]: { defaultAutoPull: true },
          [projectId]: { defaultThreadEnvMode: "worktree", defaultAutoPull: true },
        });
        yield* settings.updateSettings({
          defaultModelSelection: sol,
          projectSettingsOverrides: { [projectId]: { defaultModelSelection: sol } },
        });
        const reopened = yield* Effect.gen(function* () {
          const freshSettings = yield* ServerSettingsModule.ServerSettingsService;
          return yield* freshSettings.getSettings;
        }).pipe(
          Effect.provide(
            Layer.fresh(
              ServerSettingsModule.layerManagedTest({ TRITONAI_API_KEY: "managed-test-key" }),
            ),
          ),
        );
        assert.deepInclude(reopened.defaultModelSelection, sol);
        assert.deepEqual(reopened.projectSettingsOverrides[projectId]?.defaultModelSelection, sol);
      }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("keeps managed values effective while preserving the raw user document", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const managedInstanceId = ProviderInstanceId.make("codex");
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        encodeUnknownJson({
          unknownTopLevel: { retained: true },
          providers: {
            codex: {
              binaryPath: "/installer/runtime/codex",
              homePath: "/installer/home/codex",
              customModels: ["legacy-model"],
            },
          },
          providerInstances: {
            codex: {
              driver: "codex",
              config: {
                binaryPath: "/installer/runtime/codex",
                homePath: "/installer/home/codex",
                unknownNested: "retained",
              },
              environment: [
                { name: "UCSD_AI_BASE_URL", value: "https://legacy.invalid/v1" },
                { name: "USER_FLAG", value: "retained" },
              ],
            },
          },
          textGenerationModelSelection: {
            instanceId: "codex",
            model: "gpt-5.5",
          },
        }),
        { mode: 0o600 },
      );

      yield* serverSettings.start;
      const effective = yield* serverSettings.getSettings;
      assert.equal(getManagedCodexSettings(effective).binaryPath, "/installer/runtime/codex");
      assert.equal(getManagedCodexSettings(effective).homePath, "/installer/home/codex");
      assert.equal(effective.textGenerationModelSelection.model, "gpt-6.1-sol");
      assert.deepInclude(effective.providerInstances[managedInstanceId]?.config, {
        unknownNested: "retained",
      });
      assert.deepInclude(
        effective.providerInstances[managedInstanceId]?.environment?.find(
          ({ name }) => name === "USER_FLAG",
        ),
        { name: "USER_FLAG", value: "retained", sensitive: false },
      );

      yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/ManagedPolicyPreserved",
        providerInstances: {
          ...effective.providerInstances,
          [managedInstanceId]: {
            ...effective.providerInstances[managedInstanceId]!,
            config: {
              ...getManagedCodexSettings(effective),
              binaryPath: "/attempted/override",
              homePath: "/attempted/home",
            },
          },
        },
      });

      const afterUpdate = yield* serverSettings.getSettings;
      assert.equal(getManagedCodexSettings(afterUpdate).binaryPath, "/installer/runtime/codex");
      assert.equal(getManagedCodexSettings(afterUpdate).homePath, "/installer/home/codex");
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      const persisted = JSON.parse(raw);
      const referenceTarget =
        persisted.tritonAiManagedPolicy.providerInstanceReferenceRenames.codex_frontier;
      assert.match(referenceTarget, /^codex_frontier_personal_[0-9a-f-]{36}$/);
      assert.deepInclude(persisted, {
        unknownTopLevel: { retained: true },
        addProjectBaseDirectory: "~/ManagedPolicyPreserved",
        textGenerationModelSelection: {
          instanceId: "codex",
          model: "gpt-5.5",
        },
        tritonAiManagedPolicy: {
          migrationVersion: 2,
          codexBinaryPath: "/installer/runtime/codex",
          codexHomePath: "/installer/home/codex",
          newThreadDefaultsVersion: 1,
          providerInstanceReferenceRenames: {
            codex_frontier: referenceTarget,
          },
        },
      });
      assert.deepInclude(persisted.providerInstances.codex.config, {
        unknownNested: "retained",
      });
      assert.notInclude(raw, "/attempted/override");
      assert.notInclude(raw, "/attempted/home");
      assert.notInclude(raw, "UCSD_AI_BASE_URL");
    }).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );

  it.effect("persists custom usage prices and removes them from the settings file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const prices = {
          inputCostPerMillionTokens: 2,
          outputCostPerMillionTokens: 8,
          cacheReadCostPerMillionTokens: 0,
        };
        const readPersisted = fileSystem
          .readFileString(serverConfig.settingsPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings))));

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": prices } });
        const persisted = yield* readPersisted;
        assert.deepStrictEqual(persisted.usagePriceOverrides, { "example-model": prices });

        yield* serverSettings.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* readPersisted;
        assert.deepStrictEqual(restored.usagePriceOverrides, {});
      }),
    ).pipe(Effect.provide(makeManagedServerSettingsLayer())),
  );
});
