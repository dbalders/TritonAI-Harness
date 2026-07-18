import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SecretEnvelope from "@t3tools/shared/secretEnvelope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTritonAiApiKey from "../settings/DesktopTritonAiApiKey.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

const PersistedServerObservabilitySettingsDocument = Schema.Struct({
  observability: Schema.Struct({
    otlpTracesUrl: Schema.String,
    otlpMetricsUrl: Schema.String,
  }),
});

const encodePersistedServerObservabilitySettingsDocument = Schema.encodeEffect(
  Schema.fromJsonString(PersistedServerObservabilitySettingsDocument),
);

const isDesktopBackendObservabilitySettingsReadError = Schema.is(
  DesktopBackendConfiguration.DesktopBackendObservabilitySettingsReadError,
);

const serverExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    tailscaleServeEnabled: true,
    tailscaleServePort: 8443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
  isEncryptionAvailable: Effect.succeed(true),
  selectedStorageBackend: Effect.succeed("gnome_libsecret"),
  encryptString: (value) =>
    Effect.succeed(new TextEncoder().encode(Array.from(value).toReversed().join(""))),
  decryptString: (value) =>
    Effect.succeed(Array.from(new TextDecoder().decode(value)).toReversed().join("")),
} satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

const makeDialogLayer = (response = 0) =>
  Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.succeed(Option.none()),
    confirm: () => Effect.succeed(false),
    showMessageBox: () => Effect.succeed({ response, checkboxChecked: false }),
    showErrorBox: () => Effect.void,
  } satisfies ElectronDialog.ElectronDialog["Service"]);

const dialogLayer = makeDialogLayer();

const desktopTestServicesLayer = Layer.mergeAll(serverExposureLayer, safeStorageLayer, dialogLayer);

function makeEnvironmentLayer(
  baseDir: string,
  options?: {
    readonly appPath?: string;
    readonly isPackaged?: boolean;
    readonly devServerUrl?: string;
    readonly platform?: NodeJS.Platform;
    readonly resourcesPath?: string;
  },
) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: options?.platform ?? "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: options?.appPath ?? "/repo",
    isPackaged: options?.isPackaged ?? true,
    resourcesPath: options?.resourcesPath ?? "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          T3CODE_PORT: "9999",
          T3CODE_MODE: "desktop",
          T3CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: options?.devServerUrl,
        }),
      ),
    ),
  );
}

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });

    return yield* effect.pipe(
      Effect.provide(
        DesktopBackendConfiguration.layer.pipe(
          Layer.provideMerge(desktopTestServicesLayer),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(DesktopWslEnvironment.layerTest()),
          Layer.provideMerge(makeEnvironmentLayer(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopBackendConfiguration", () => {
  it.effect("resolvePrimary produces a stable scoped bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const first = yield* configuration.resolvePrimary;
        const second = yield* configuration.resolvePrimary;

        assert.equal(first.executablePath, process.execPath);
        assert.equal(first.entryPath, environment.backendEntryPath);
        assert.equal(first.cwd, environment.backendCwd);
        assert.equal(first.captureOutput, true);
        assert.equal(first.env.ELECTRON_RUN_AS_NODE, "1");
        assert.isUndefined(first.env.T3CODE_PORT);
        assert.isUndefined(first.env.T3CODE_MODE);
        assert.isUndefined(first.env.T3CODE_DESKTOP_LAN_HOST);

        assert.equal(first.bootstrap.mode, "desktop");
        assert.equal(first.bootstrap.noBrowser, true);
        assert.equal(first.bootstrap.port, 4888);
        assert.equal(first.bootstrap.host, "0.0.0.0");
        assert.equal(first.bootstrap.t3Home, environment.baseDir);
        assert.equal(first.bootstrap.tailscaleServeEnabled, true);
        assert.equal(first.bootstrap.tailscaleServePort, 8443);
        assert.match(first.bootstrap.desktopBootstrapToken, /^[0-9a-f]{48}$/i);
        assert.equal(second.bootstrap.desktopBootstrapToken, first.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolveWsl reuses the primary's bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const primary = yield* configuration.resolvePrimary;
        const wsl = yield* configuration.resolveWsl({ port: 5000, distro: null });

        assert.equal(wsl.bootstrap.desktopBootstrapToken, primary.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolveWsl pins a default-tracking run to the concrete default distro", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");

      const observedDistros: Array<string | null> = [];
      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolveWsl({ port: 5000, distro: null });
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(desktopTestServicesLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [
                  { name: "Debian", isDefault: false, version: 2 },
                  { name: "Ubuntu", isDefault: true, version: 2 },
                ],
                windowsToWslPath: (distro) => {
                  observedDistros.push(distro);
                  return Option.some("/repo/apps/server/dist/bin.mjs");
                },
                ensureNodePty: (distro) => {
                  observedDistros.push(distro);
                  return { ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin:/bin" };
                },
                getDistroIp: (distro) => {
                  observedDistros.push(distro);
                  return Option.some("172.27.0.99");
                },
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );

      assert.equal(config.runningDistro, "Ubuntu");
      assert.deepEqual(config.args.slice(0, 2), ["-d", "Ubuntu"]);
      assert.deepEqual(observedDistros, ["Ubuntu", "Ubuntu", "Ubuntu"]);
      assert.isTrue(Option.isNone(config.preflightFailure));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl authorizes only approved distro-local legacy credentials", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-wsl-secret-migration-",
      });
      const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");
      const name = "integration-microsoft-365--oauth";
      const value = new TextEncoder().encode("wsl-refresh-token");
      const inventoryCalls: Array<readonly [string | null, boolean]> = [];

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(serverExposureLayer, safeStorageLayer, makeDialogLayer(1)),
            ),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                windowsToWslPath: () => Option.some("/repo/apps/server/dist/bin.mjs"),
                ensureNodePty: () => ({
                  ok: true,
                  nodePath: "/usr/bin/node",
                  resolvedPath: "/usr/bin:/bin",
                }),
                getDistroIp: () => Option.some("172.27.0.99"),
                readSecretFiles: (distro, development) => {
                  inventoryCalls.push([distro, development]);
                  return { ok: true, files: [{ name, value }] };
                },
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );

      const activeKey = Buffer.from(config.bootstrap.secretStoreKeys[0]!, "base64");
      const expected = Buffer.from(
        SecretEnvelope.fingerprintLegacyServerSecret(name, value, activeKey),
      ).toString("base64");
      assert.deepEqual(config.bootstrap.legacySecretFingerprints, { [name]: expected });
      assert.deepEqual(inventoryCalls, [["Ubuntu", false]]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolveWsl preserves inherited PATH with quote-sensitive values as separate args",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });
        const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
        yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
        yield* fileSystem.writeFileString(entryPath, "");

        const nodePath = "/home/test user's/.nvm/versions/node/v22.0.0/bin/node";
        const linuxEntryPath = "/tmp/t3 code's launch/entry file.mjs";
        const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
        const devServerUrl = "http://127.0.0.1:5733/dev%20assets/?label=hello%20world";
        const config = yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          return yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(desktopTestServicesLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                  windowsToWslPath: () => Option.some(linuxEntryPath),
                  ensureNodePty: () => ({ ok: true, nodePath, resolvedPath }),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(
                makeEnvironmentLayer(baseDir, {
                  appPath: baseDir,
                  devServerUrl,
                  isPackaged: true,
                  platform: "win32",
                  resourcesPath: baseDir,
                }),
              ),
            ),
          ),
        );

        assert.equal(config.bootstrapDelivery, "stdin");
        assert.deepEqual(config.args, [
          "-d",
          "Ubuntu",
          "--exec",
          "env",
          "PATH=/home/test user's/.nvm/versions/node/v22.0.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin",
          nodePath,
          linuxEntryPath,
          "--bootstrap-fd",
          "0",
          "--dev-url",
          devServerUrl,
        ]);
        assert.notInclude(config.args, "bash");
        assert.notInclude(config.args, "/bin/sh");
        assert.notInclude(config.args, "-c");
        assert.isTrue(Option.isNone(config.preflightFailure));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimary and resolveWsl share one token under concurrent resolution", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        // Resolve both before any token is cached, concurrently, so the
        // generate step (a yield point) can interleave. The atomic
        // get-or-create must still hand both the same token; a non-atomic
        // Ref would let each generate its own and break the shared-token
        // invariant.
        const [primary, wsl] = yield* Effect.all(
          [configuration.resolvePrimary, configuration.resolveWsl({ port: 5000, distro: null })],
          { concurrency: "unbounded" },
        );

        assert.equal(wsl.bootstrap.desktopBootstrapToken, primary.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolvePrimary surfaces persisted backend observability endpoints", () =>
    withHarness(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        yield* fileSystem.makeDirectory(environment.path.dirname(environment.serverSettingsPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          environment.serverSettingsPath,
          yield* encodePersistedServerObservabilitySettingsDocument({
            observability: {
              otlpTracesUrl: " http://127.0.0.1:4318/v1/traces ",
              otlpMetricsUrl: " http://127.0.0.1:4318/v1/metrics ",
            },
          }),
        );

        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://127.0.0.1:4318/v1/metrics");
      }),
    ),
  );

  it.effect("resolvePrimary omits backend observability endpoints when settings are missing", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;

        assert.isUndefined(config.bootstrap.otlpTracesUrl);
        assert.isUndefined(config.bootstrap.otlpMetricsUrl);
      }),
    ),
  );

  it.effect("resolvePrimary passes UCSD installer environment into the backend process", () =>
    Effect.gen(function* () {
      const previousTritonAiKey = process.env.TRITONAI_API_KEY;
      const previousUcsdAiBaseUrl = process.env.UCSD_AI_BASE_URL;
      const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
      try {
        delete process.env.TRITONAI_API_KEY;
        delete process.env.UCSD_AI_BASE_URL;
        delete process.env.OPENCODE_CONFIG;

        yield* withHarness(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
            const envFile = environment.path.join(
              environment.homeDirectory,
              ".agents",
              "ucsd",
              "env",
            );

            yield* fileSystem.makeDirectory(environment.path.dirname(envFile), {
              recursive: true,
            });
            yield* fileSystem.writeFileString(
              envFile,
              [
                "export UCSD_AI_BASE_URL=https://tritonai-api.ucsd.edu/v1",
                "export TRITONAI_API_KEY='triton-key'",
                'export OPENCODE_CONFIG="/Users/test/.agents/ucsd/config/opencode/opencode.json"',
                'export UCSD_ESCAPED_VALUE="escaped \\"quote\\" and \\$dollar and \\`tick\\`"',
                "export UCSD_QUOTED_NAME='Triton AI'\\''s API'",
                "export T3CODE_PORT=1234",
                "export TRITONAI_HOME=/tmp/wrong-home",
                "",
              ].join("\n"),
            );

            const config = yield* configuration.resolvePrimary;
            assert.equal(config.env.UCSD_AI_BASE_URL, "https://tritonai-api.ucsd.edu/v1");
            assert.equal(config.env.TRITONAI_API_KEY, "triton-key");
            assert.equal(
              config.env.OPENCODE_CONFIG,
              "/Users/test/.agents/ucsd/config/opencode/opencode.json",
            );
            assert.equal(config.env.UCSD_ESCAPED_VALUE, 'escaped "quote" and $dollar and `tick`');
            assert.equal(config.env.UCSD_QUOTED_NAME, "Triton AI's API");
            assert.isUndefined(config.env.T3CODE_PORT);
            assert.isUndefined(config.env.TRITONAI_HOME);
          }),
        );
      } finally {
        restoreEnv("TRITONAI_API_KEY", previousTritonAiKey);
        restoreEnv("UCSD_AI_BASE_URL", previousUcsdAiBaseUrl);
        restoreEnv("OPENCODE_CONFIG", previousOpenCodeConfig);
      }
    }),
  );

  it.effect("resolvePrimary prefers the persistent desktop key override", () =>
    Effect.gen(function* () {
      const previousTritonAiKey = process.env.TRITONAI_API_KEY;
      try {
        process.env.TRITONAI_API_KEY = "old-key";

        yield* withHarness(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
            const envFile = environment.path.join(
              environment.homeDirectory,
              ".agents",
              "ucsd",
              "env",
            );
            yield* fileSystem.makeDirectory(environment.path.dirname(envFile), {
              recursive: true,
            });
            yield* fileSystem.writeFileString(envFile, "export TRITONAI_API_KEY='setup-key'\n");
            yield* DesktopTritonAiApiKey.replaceTritonAiApiKey("new-key");

            const first = yield* configuration.resolvePrimary;
            const afterRelaunch = yield* configuration.resolvePrimary;
            assert.equal(first.env.TRITONAI_API_KEY, "new-key");
            assert.equal(afterRelaunch.env.TRITONAI_API_KEY, "new-key");
          }),
        );
      } finally {
        restoreEnv("TRITONAI_API_KEY", previousTritonAiKey);
      }
    }),
  );

  it.effect("logs structured context when persisted observability settings cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const settingsPath = path.join(baseDir, "userdata", "settings.json");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: settingsPath,
      });
      const messages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      const failingFileSystemLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const liveFileSystem = yield* FileSystem.FileSystem;
          return {
            ...liveFileSystem,
            readFileString: (target, encoding) =>
              String(target) === settingsPath
                ? Effect.fail(cause)
                : liveFileSystem.readFileString(target, encoding),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolvePrimary;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(desktopTestServicesLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslEnvironment.layerTest()),
              Layer.provideMerge(makeEnvironmentLayer(baseDir)),
              Layer.provideMerge(failingFileSystemLayer),
            ),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );

      assert.isUndefined(config.bootstrap.otlpTracesUrl);
      assert.isUndefined(config.bootstrap.otlpMetricsUrl);

      const error = messages
        .flatMap((message) => (Array.isArray(message) ? message : [message]))
        .find(isDesktopBackendObservabilitySettingsReadError);
      assert.isDefined(error);
      assert.equal(error.settingsPath, settingsPath);
      assert.equal(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to read persisted backend observability settings at ${settingsPath}.`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimary captures backend output in dev so child logs can be persisted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.captureOutput, true);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(desktopTestServicesLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                isPackaged: false,
                devServerUrl: "http://127.0.0.1:5733",
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl preserves existing WSLENV entries when forwarding backend secrets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const previousWslEnv = process.env.WSLENV;
      const previousOpenAiKey = process.env.OPENAI_API_KEY;
      const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const previousTritonAiKey = process.env.TRITONAI_API_KEY;
      const previousUcsdAiBaseUrl = process.env.UCSD_AI_BASE_URL;
      try {
        process.env.WSLENV = "GOPATH/p:OPENAI_API_KEY/u:EMPTY::AZURE_DEVOPS_EXT_PAT/u";
        process.env.OPENAI_API_KEY = "openai-key";
        process.env.ANTHROPIC_API_KEY = "anthropic-key";
        process.env.TRITONAI_API_KEY = "tritonai-key";
        process.env.UCSD_AI_BASE_URL = "https://voice.example.test/v1";

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolveWsl({ port: 5050, distro: null });

          assert.equal(config.executablePath, "wsl.exe");
          assert.equal(config.bootstrap.port, 5050);
          // Binds to 0.0.0.0 inside WSL so the backend is reachable via
          // both wslhost-forwarded localhost and the distro's eth0 IP.
          assert.equal(config.bootstrap.host, "0.0.0.0");
          assert.equal(config.bootstrap.tailscaleServeEnabled, false);
          // httpBaseUrl uses the resolved distro IP from the test stub,
          // not localhost — the renderer reaches the backend directly to
          // avoid relying on wslhost forwarding.
          assert.equal(config.httpBaseUrl.href, "http://172.27.0.99:5050/");
          assert.equal(config.env.OPENAI_API_KEY, "openai-key");
          assert.equal(config.env.ANTHROPIC_API_KEY, "anthropic-key");
          assert.equal(config.env.TRITONAI_API_KEY, "tritonai-key");
          assert.equal(config.env.UCSD_AI_BASE_URL, "https://voice.example.test/v1");
          // The existing WSLENV is preserved byte-for-byte (note the empty
          // "::" segment survives — WSL ignores it, so we don't normalize
          // it away) and missing backend secret names are appended.
          // OPENAI_API_KEY is already declared, so it isn't forwarded twice.
          assert.equal(
            config.env.WSLENV,
            "GOPATH/p:OPENAI_API_KEY/u:EMPTY::AZURE_DEVOPS_EXT_PAT/u:ANTHROPIC_API_KEY:TRITONAI_API_KEY:UCSD_AI_BASE_URL",
          );
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(desktopTestServicesLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      } finally {
        restoreEnv("WSLENV", previousWslEnv);
        restoreEnv("OPENAI_API_KEY", previousOpenAiKey);
        restoreEnv("ANTHROPIC_API_KEY", previousAnthropicKey);
        restoreEnv("TRITONAI_API_KEY", previousTritonAiKey);
        restoreEnv("UCSD_AI_BASE_URL", previousUcsdAiBaseUrl);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl forwards UCSD environment and prefers the desktop key override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const envFile = path.join(baseDir, ".agents", "ucsd", "env");
      yield* fileSystem.makeDirectory(path.dirname(envFile), { recursive: true });
      yield* fileSystem.writeFileString(
        envFile,
        [
          "export TRITONAI_API_KEY='installer-triton-key'",
          "export UCSD_AI_BASE_URL=https://installer.example.edu/v1",
          "",
        ].join("\n"),
      );
      yield* DesktopTritonAiApiKey.replaceTritonAiApiKey("wsl-key").pipe(
        Effect.provide(makeEnvironmentLayer(baseDir)),
      );

      const previousWslEnv = process.env.WSLENV;
      const previousOpenAiKey = process.env.OPENAI_API_KEY;
      const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const previousTritonAiKey = process.env.TRITONAI_API_KEY;
      const previousUcsdAiBaseUrl = process.env.UCSD_AI_BASE_URL;
      try {
        process.env.WSLENV = "GOPATH/p";
        delete process.env.OPENAI_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.TRITONAI_API_KEY;
        delete process.env.UCSD_AI_BASE_URL;

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolveWsl({ port: 5050, distro: null });

          assert.equal(config.env.TRITONAI_API_KEY, "wsl-key");
          assert.equal(config.env.UCSD_AI_BASE_URL, "https://installer.example.edu/v1");
          assert.equal(config.env.WSLENV, "GOPATH/p:TRITONAI_API_KEY:UCSD_AI_BASE_URL");
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(desktopTestServicesLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      } finally {
        restoreEnv("WSLENV", previousWslEnv);
        restoreEnv("OPENAI_API_KEY", previousOpenAiKey);
        restoreEnv("ANTHROPIC_API_KEY", previousAnthropicKey);
        restoreEnv("TRITONAI_API_KEY", previousTritonAiKey);
        restoreEnv("UCSD_AI_BASE_URL", previousUcsdAiBaseUrl);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolvePrimary falls back to the Windows primary when wsl-only but WSL is unavailable",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });

        yield* Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolvePrimary;

          // wsl-only is persisted but WSL is unavailable, so the primary must
          // not spawn wsl.exe (which would loop on preflight failures while the
          // Connections backend control is hidden). Resolve the Windows primary.
          assert.equal(config.executablePath, process.execPath);
          assert.equal(config.bootstrap.t3Home, environment.baseDir);
          assert.isTrue(Option.isNone(config.preflightFailure));
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(desktopTestServicesLayer),
              Layer.provideMerge(
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  wslBackendEnabled: true,
                  wslOnly: true,
                }),
              ),
              Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: false })),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolvePrimary marks a removed persisted WSL distro as a fatal preflight failure",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolvePrimary;
          const failure = Option.getOrThrow(config.preflightFailure);

          assert.equal(config.executablePath, "wsl.exe");
          assert.isTrue(failure.fatal);
          assert.include(failure.reason, "Removed-Distro");
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(desktopTestServicesLayer),
              Layer.provideMerge(
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  wslBackendEnabled: true,
                  wslOnly: true,
                  wslDistro: "Removed-Distro",
                }),
              ),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                }),
              ),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl keeps a transient distro-list failure retryable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "timed out");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(desktopTestServicesLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distroListError: new DesktopWslEnvironment.DesktopWslDistroListError({
                  reason: "wsl.exe --list --verbose timed out",
                }),
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl marks a missing packaged server entry as fatal", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isTrue(failure.fatal);
        assert.include(failure.reason, "missing server entry");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(desktopTestServicesLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl marks a missing selected distro as a fatal preflight failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Removed-Distro" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isTrue(failure.fatal);
        assert.include(failure.reason, "Removed-Distro");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(desktopTestServicesLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimaryLabel reports the WSL distro when wsl-only and WSL is available", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "WSL (Ubuntu)");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(desktopTestServicesLayer),
            Layer.provideMerge(
              DesktopAppSettings.layerTest({
                ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                wslBackendEnabled: true,
                wslOnly: true,
                wslDistro: "Ubuntu",
              }),
            ),
            Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimaryLabel reports the local environment on non-Windows platforms", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "Local environment");
      }),
    ),
  );

  it.effect("resolvePrimaryLabel reports Windows when wsl-only but WSL is unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        // Mirrors the resolvePrimary fall-back: the label must follow the
        // backend that actually resolves, not the persisted preference, so the
        // env switcher can't show "WSL" for a Windows backend.
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "Windows");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(desktopTestServicesLayer),
            Layer.provideMerge(
              DesktopAppSettings.layerTest({
                ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                wslBackendEnabled: true,
                wslOnly: true,
                wslDistro: "Ubuntu",
              }),
            ),
            Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: false })),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("resolvePrimaryLabel is runSync-safe against the real WSL availability probe", async () => {
    // getLocalEnvironmentBootstraps is a sync IPC method: it resolves the
    // primary instance's lazy label through Effect.runSync. The label chains
    // to wslEnvironment.isAvailable, whose real layer probes the filesystem.
    // That probe must run once at layer build and expose a resolved value, not
    // a live async effect — otherwise runSync throws in the handler. Build the
    // real WSL layer (not the sync test stub) and resolve the label with a
    // top-level runSync, exactly as the handler does.
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This test intentionally replicates the sync IPC handler's runSync path to catch a regression to async-only resolution; it.effect would mask it.
    const runtime = ManagedRuntime.make(
      DesktopBackendConfiguration.layer.pipe(
        Layer.provideMerge(desktopTestServicesLayer),
        Layer.provideMerge(DesktopAppSettings.layerTest()),
        Layer.provideMerge(DesktopWslEnvironment.layer),
        // isAvailable on win32 only touches the filesystem, never the spawner,
        // so a die-stub is enough to satisfy the layer's deps.
        Layer.provideMerge(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.die("spawner should not be used while probing WSL availability"),
            ),
          ),
        ),
        Layer.provideMerge(makeEnvironmentLayer("/tmp/t3-wsl-isavailable", { platform: "win32" })),
        Layer.provide(NodeServices.layer),
      ),
    );
    try {
      const configuration = await runtime.runPromise(
        DesktopBackendConfiguration.DesktopBackendConfiguration,
      );
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Same reason: this is the synchronous resolution the IPC handler performs.
      const label = Effect.runSync(configuration.resolvePrimaryLabel);
      assert.equal(typeof label, "string");
    } finally {
      await runtime.dispose();
    }
  });
});
