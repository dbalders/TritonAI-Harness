import * as NodeOS from "node:os";

import { assert, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { deriveServerPaths } from "../config.ts";
import { resolveServerConfig } from "./config.ts";

const encodeDesktopBootstrap = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));
const headlessKeyFileSetting = ["TRITONAI", "SECRET", "STORE", "KEY", "FILE"].join("_");
const encodeSecretStoreKeyring = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      active: Schema.String,
      previous: Schema.Array(Schema.String),
    }),
  ),
);

const makeDesktopBootstrap = (
  overrides: Partial<DesktopBackendBootstrapValue> = {},
): DesktopBackendBootstrapValue => ({
  secretStoreKeys: ["WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo="],
  legacySecretFingerprints: {},
  mode: "desktop",
  noBrowser: true,
  port: 4888,
  t3Home: "/tmp/t3-bootstrap-home",
  host: "127.0.0.1",
  desktopBootstrapToken: "desktop-bootstrap-token",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
  ...overrides,
});

it.layer(NodeServices.layer)("cli config resolution", (it) => {
  const defaultObservabilityConfig = {
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
  } as const;

  const openBootstrapFd = Effect.fn(function* (payload: DesktopBackendBootstrapValue) {
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* fs.makeTempFileScoped({ prefix: "t3-bootstrap-", suffix: ".ndjson" });
    const encoded = yield* encodeDesktopBootstrap(payload);
    yield* fs.writeFileString(filePath, `${encoded}\n`);
    const { fd } = yield* fs.open(filePath, { flag: "r" });
    return fd;
  });

  it.effect("prefers TRITONAI_HOME over the legacy home input when flags are omitted", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-env-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:5173"));
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_LOG_LEVEL: "Warn",
                  T3CODE_MODE: "desktop",
                  T3CODE_PORT: "4001",
                  T3CODE_HOST: "0.0.0.0",
                  TRITONAI_HOME: baseDir,
                  T3CODE_HOME: join(NodeOS.tmpdir(), "ignored-legacy-base"),
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  T3CODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Warn",
        ...defaultObservabilityConfig,
        mode: "desktop",
        port: 4001,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "0.0.0.0",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:5173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        secretStoreKeys: undefined,
        legacySecretFingerprints: {},
      });
    }),
  );

  it.effect("uses CLI flags when provided", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-flags-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));
      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(true),
          logWebSocketEvents: Option.some(true),
          tailscaleServeEnabled: Option.some(true),
          tailscaleServePort: Option.some(8443),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_LOG_LEVEL: "Warn",
                  T3CODE_MODE: "desktop",
                  T3CODE_PORT: "4001",
                  T3CODE_HOST: "0.0.0.0",
                  T3CODE_HOME: join(NodeOS.tmpdir(), "ignored-base"),
                  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
                  T3CODE_NO_BROWSER: "false",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
                  T3CODE_LOG_WS_EVENTS: "false",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
        tailscaleServeEnabled: true,
        tailscaleServePort: 8443,
        secretStoreKeys: undefined,
        legacySecretFingerprints: {},
      });
    }),
  );

  it.effect("preserves explicit false CLI boolean flags over env and bootstrap values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-false-flags");
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          noBrowser: true,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
      );
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.some(false),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_BOOTSTRAP_FD: String(fd),
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  T3CODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: false,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-bootstrap-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        secretStoreKeys: ["WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo="],
        legacySecretFingerprints: {},
      });
    }),
  );

  it.effect("uses bootstrap envelope values as fallbacks when flags and env are absent", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = "/tmp/t3-bootstrap-home";
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          port: 4888,
          host: "127.0.0.2",
          t3Home: baseDir,
          noBrowser: true,
          desktopBootstrapToken: "desktop-token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        }),
      );
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.none(),
          host: Option.none(),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_BOOTSTRAP_FD: String(fd),
                  [headlessKeyFileSetting]: "/missing/lower-precedence-keyring.json",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.2",
        staticDir: resolved.staticDir,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-token",
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        secretStoreKeys: ["WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo="],
        legacySecretFingerprints: {},
      });
      assert.equal(join(baseDir, "userdata"), resolved.stateDir);
    }),
  );

  it.effect("creates derived runtime directories during config resolution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-dirs-" });
      const customCwd = path.join(baseDir, "nested", "project");

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.some(customCwd),
          devUrl: Option.some(new URL("http://127.0.0.1:5173")),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      for (const directory of [
        customCwd,
        resolved.stateDir,
        resolved.logsDir,
        resolved.providerLogsDir,
        resolved.terminalLogsDir,
        resolved.attachmentsDir,
        resolved.worktreesDir,
        path.dirname(resolved.serverLogPath),
        path.dirname(resolved.serverTracePath),
      ]) {
        expect(yield* fs.exists(directory)).toBe(true);
      }
      expect(resolved.cwd).toBe(path.resolve(customCwd));
    }),
  );

  it.effect("accepts the legacy home input between flags and bootstrap values", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-env-wins");
      const fd = yield* openBootstrapFd(
        makeDesktopBootstrap({
          port: 4888,
          host: "127.0.0.2",
          t3Home: "/tmp/t3-bootstrap-home",
          noBrowser: false,
          desktopBootstrapToken: "desktop-token",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        }),
      );
      const derivedPaths = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:4173"));

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.none(),
          port: Option.some(8788),
          host: Option.some("127.0.0.1"),
          baseDir: Option.none(),
          cwd: Option.none(),
          devUrl: Option.some(new URL("http://127.0.0.1:4173")),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.some("Debug"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_MODE: "web",
                  T3CODE_BOOTSTRAP_FD: String(fd),
                  T3CODE_HOME: baseDir,
                  T3CODE_NO_BROWSER: "true",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                  T3CODE_LOG_WS_EVENTS: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Debug",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 8788,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: new URL("http://127.0.0.1:4173"),
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: "desktop-token",
        autoBootstrapProjectFromCwd: true,
        logWebSocketEvents: true,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        secretStoreKeys: ["WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo="],
        legacySecretFingerprints: {},
      });
    }),
  );

  it.effect("falls back to persisted observability settings when env vars are absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-config-settings-" });
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(path.dirname(derivedPaths.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        derivedPaths.settingsPath,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        `${JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        })}\n`,
      );

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("desktop"),
          port: Option.some(4888),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
      expect(resolved.otlpMetricsUrl).toBe("http://localhost:4318/v1/metrics");
      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        mode: "desktop",
        port: 4888,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: "127.0.0.1",
        staticDir: resolved.staticDir,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "browser",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        secretStoreKeys: undefined,
        legacySecretFingerprints: {},
      });
    }),
  );

  it.effect("forces noBrowser and disables auto-bootstrap for headless startup presentation", () =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = join(NodeOS.tmpdir(), "t3-cli-config-headless-base");
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(baseDir),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.none(),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
        {
          startupPresentation: "headless",
        },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  T3CODE_NO_BROWSER: "false",
                  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "true",
                },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved).toEqual({
        logLevel: "Info",
        ...defaultObservabilityConfig,
        mode: "web",
        port: 3773,
        cwd: process.cwd(),
        baseDir,
        ...derivedPaths,
        host: undefined,
        staticDir: resolved.staticDir,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        secretStoreKeys: undefined,
        legacySecretFingerprints: {},
      });
    }),
  );

  it.effect("loads an explicit headless secret-store keyring", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const keyFilePath = yield* fs.makeTempFileScoped({
        prefix: "t3-secret-keyring-",
        suffix: ".json",
      });
      yield* fs.writeFileString(
        keyFilePath,
        yield* encodeSecretStoreKeyring({
          version: 1,
          active: "WVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVk=",
          previous: ["WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo="],
        }),
      );
      yield* fs.chmod(keyFilePath, 0o600);

      const resolved = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(NodeOS.tmpdir()),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { TRITONAI_SECRET_STORE_KEY_FILE: keyFilePath },
              }),
            ),
            NetService.layer,
          ),
        ),
      );

      expect(resolved.secretStoreKeys).toEqual([
        "WVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVk=",
        "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo=",
      ]);
      expect(resolved.secretStoreKeyFilePath).toBe(keyFilePath);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a headless keyring readable by other POSIX users", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const keyFilePath = yield* fs.makeTempFileScoped({
        prefix: "t3-insecure-keyring-",
        suffix: ".json",
      });
      yield* fs.writeFileString(
        keyFilePath,
        yield* encodeSecretStoreKeyring({
          version: 1,
          active: "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo=",
          previous: [],
        }),
      );
      yield* fs.chmod(keyFilePath, 0o644);

      const error = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(NodeOS.tmpdir()),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { TRITONAI_SECRET_STORE_KEY_FILE: keyFilePath },
              }),
            ),
            NetService.layer,
          ),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, PlatformError.PlatformError);
      assert.equal(error.reason._tag, "PermissionDenied");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a symbolic link to a headless keyring on POSIX", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-keyring-symlink-" });
      const targetPath = `${directory}/keyring.json`;
      const linkPath = `${directory}/keyring-link.json`;
      yield* fs.writeFileString(
        targetPath,
        yield* encodeSecretStoreKeyring({
          version: 1,
          active: "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo=",
          previous: [],
        }),
      );
      yield* fs.chmod(targetPath, 0o600);
      yield* fs.symlink(targetPath, linkPath);

      const error = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.none(),
          baseDir: Option.some(NodeOS.tmpdir()),
          cwd: Option.none(),
          devUrl: Option.none(),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.none(),
          logWebSocketEvents: Option.none(),
          tailscaleServeEnabled: Option.none(),
          tailscaleServePort: Option.none(),
        },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { TRITONAI_SECRET_STORE_KEY_FILE: linkPath },
              }),
            ),
            NetService.layer,
          ),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, PlatformError.PlatformError);
      assert.equal(error.reason._tag, "PermissionDenied");
    }).pipe(Effect.scoped),
  );
});
