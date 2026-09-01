import { currentMacOsPermissionStatus } from "@trycua/cua-driver";
import {
  EmbeddedCuaDriverHost,
  EmbeddedDriverHostOptions,
  EmbeddedPermissionMode,
  type EmbeddedDriverConnection,
} from "@trycua/cua-driver/embedded";
import {
  hasRequiredMacOSPermissions,
  openMacOSScreenRecordingSettings,
  requestMacOSPermissions,
  type MacOSPermissionStatus,
} from "@trycua/cua-driver/electron";
import type { DesktopComputerUseState, DesktopMcpServerConfiguration } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const CUA_DRIVER_PATH_ENV = "TRITONAI_CUA_DRIVER_PATH";
const CUA_DRIVER_HOME_DIRNAME = "cua-driver-home";
const CUA_DRIVER_CONFIG_DIRNAME = ".cua-driver";
const CUA_DRIVER_CONFIG_FILENAME = "config.json";

export const CUA_DRIVER_POLICY = {
  telemetry_enabled: false,
  update_check_enabled: false,
} as const;
export const CuaDriverPolicy = Schema.Struct({
  telemetry_enabled: Schema.Boolean,
  update_check_enabled: Schema.Boolean,
});
const encodeCuaDriverPolicy = Schema.encodeSync(Schema.fromJsonString(CuaDriverPolicy));

type EmbeddedHost = ReturnType<typeof EmbeddedCuaDriverHost.withOptions> & {
  readonly uniffiDestroy?: () => void;
};

class DesktopComputerUseRuntimeError extends Schema.TaggedErrorClass<DesktopComputerUseRuntimeError>()(
  "DesktopComputerUseRuntimeError",
  {
    operation: Schema.Literals([
      "availability",
      "permissions",
      "open-settings",
      "policy",
      "start",
      "stop",
    ]),
    cause: Schema.Defect(),
  },
) {}

export function resolveCuaDriverBinaryPath(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  configuredPath: string | undefined = process.env[CUA_DRIVER_PATH_ENV],
): string {
  const override = configuredPath?.trim();
  if (override && !environment.isPackaged) return environment.path.resolve(override);
  const executableName = environment.platform === "win32" ? "cua-driver.exe" : "cua-driver";
  return environment.path.join(environment.resourcesPath, "cua-driver", executableName);
}

export function createCuaDriverHostOptions(input: {
  readonly binaryPath: string;
  readonly driverHomeDirectory: string;
  readonly hostBundleId: string;
  readonly inheritStderr: boolean;
}) {
  return EmbeddedDriverHostOptions.new({
    binaryPath: input.binaryPath,
    hostBundleId: input.hostBundleId,
    permissionMode: EmbeddedPermissionMode.Standard,
    approveSessionPolicy: false,
    dangerouslyBypassApprovals: false,
    // Embedded mode reserves driver-control environment variables, including
    // the telemetry and update-check flags. HOME is SDK-allowlisted, so point
    // the driver at the app-owned policy prepared below instead.
    environment: [{ name: "HOME", value: input.driverHomeDirectory }],
    inheritStderr: input.inheritStderr,
  });
}

export function prepareCuaDriverHome(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: { readonly join: (...paths: ReadonlyArray<string>) => string };
  readonly driverHomeDirectory: string;
}) {
  const configDirectory = input.path.join(input.driverHomeDirectory, CUA_DRIVER_CONFIG_DIRNAME);
  const configPath = input.path.join(configDirectory, CUA_DRIVER_CONFIG_FILENAME);

  return Effect.gen(function* () {
    yield* input.fileSystem.makeDirectory(configDirectory, { recursive: true });
    yield* input.fileSystem.writeFileString(
      configPath,
      `${encodeCuaDriverPolicy(CUA_DRIVER_POLICY)}\n`,
      { mode: 0o600 },
    );
    return configPath;
  });
}

function destroyHost(host: EmbeddedHost): void {
  host.uniffiDestroy?.();
}

export class DesktopComputerUse extends Context.Service<
  DesktopComputerUse,
  {
    readonly acquire: Effect.Effect<void, never, Scope.Scope>;
    readonly getState: (
      enabled: boolean,
    ) => Effect.Effect<DesktopComputerUseState, DesktopComputerUseRuntimeError>;
    readonly requestPermissions: Effect.Effect<
      MacOSPermissionStatus | null,
      DesktopComputerUseRuntimeError
    >;
    readonly currentMcpConfiguration: Effect.Effect<DesktopMcpServerConfiguration | undefined>;
  }
>()("@t3tools/desktop/computerUse/DesktopComputerUse") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const connectionRef = yield* Ref.make<EmbeddedDriverConnection | undefined>(undefined);
  const binaryPath = resolveCuaDriverBinaryPath(environment);
  const driverHomeDirectory = environment.path.join(
    environment.stateDir,
    "computer-use",
    CUA_DRIVER_HOME_DIRNAME,
  );

  const readPermissionStatus = Effect.fn("desktop.computerUse.readPermissionStatus")(function* (
    request: boolean,
  ) {
    if (environment.platform !== "darwin") return null;
    return yield* Effect.try({
      try: request ? requestMacOSPermissions : currentMacOsPermissionStatus,
      catch: (cause) => new DesktopComputerUseRuntimeError({ operation: "permissions", cause }),
    });
  });

  const getState = Effect.fn("desktop.computerUse.getState")(function* (enabled: boolean) {
    const [available, permissionStatus, connection] = yield* Effect.all([
      fileSystem
        .exists(binaryPath)
        .pipe(
          Effect.mapError(
            (cause) => new DesktopComputerUseRuntimeError({ operation: "availability", cause }),
          ),
        ),
      readPermissionStatus(false),
      Ref.get(connectionRef),
    ]);
    return {
      enabled,
      available,
      running: connection !== undefined,
      accessibilityPermission: permissionStatus?.accessibility ?? null,
      screenRecordingPermission: permissionStatus?.screenRecording ?? null,
    } satisfies DesktopComputerUseState;
  });

  const requestPermissions = Effect.gen(function* () {
    const permissionStatus = yield* readPermissionStatus(true);
    if (permissionStatus !== null && !permissionStatus.screenRecording) {
      yield* Effect.tryPromise({
        try: openMacOSScreenRecordingSettings,
        catch: (cause) => new DesktopComputerUseRuntimeError({ operation: "open-settings", cause }),
      });
    }
    return permissionStatus;
  }).pipe(Effect.withSpan("desktop.computerUse.requestPermissions"));

  const acquire = Effect.gen(function* () {
    const attempt = Effect.gen(function* () {
      const state = yield* getState(true);

      if (!state.available) {
        yield* Effect.logWarning(
          environment.isPackaged
            ? `Bundled Cua Driver is missing at ${binaryPath}; computer use is unavailable.`
            : `Cua Driver is unavailable. Set ${CUA_DRIVER_PATH_ENV} to a local cua-driver executable.`,
        );
        return;
      }

      if (
        environment.platform === "darwin" &&
        !hasRequiredMacOSPermissions({
          accessibility: state.accessibilityPermission === true,
          screenRecording: state.screenRecordingPermission === true,
        })
      ) {
        yield* Effect.logWarning(
          "Computer use is enabled but waiting for macOS Accessibility and Screen Recording permissions.",
        );
        return;
      }

      yield* prepareCuaDriverHome({
        fileSystem,
        path: environment.path,
        driverHomeDirectory,
      }).pipe(
        Effect.mapError(
          (cause) => new DesktopComputerUseRuntimeError({ operation: "policy", cause }),
        ),
      );

      const host = EmbeddedCuaDriverHost.withOptions(
        createCuaDriverHostOptions({
          binaryPath,
          driverHomeDirectory,
          hostBundleId: environment.appUserModelId,
          inheritStderr: environment.isDevelopment,
        }),
      ) as EmbeddedHost;

      const connection = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => host.start(),
          catch: (cause) => new DesktopComputerUseRuntimeError({ operation: "start", cause }),
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              destroyHost(host);
            }),
          ),
        ),
        () =>
          Effect.tryPromise({
            try: () => host.stop(),
            catch: (cause) => new DesktopComputerUseRuntimeError({ operation: "stop", cause }),
          }).pipe(
            Effect.catch((error) => Effect.logWarning("Failed to stop Cua Driver cleanly.", error)),
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Ref.set(connectionRef, undefined);
                destroyHost(host);
              }),
            ),
          ),
      );

      yield* Ref.set(connectionRef, connection);
      yield* Effect.logInfo("Cua Driver ready.", {
        driverVersion: connection.driverVersion,
        contractVersion: connection.contractVersion,
        pid: connection.pid,
      });
    });

    yield* attempt.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Cua Driver is unavailable for this app session.", error),
      ),
    );
  }).pipe(Effect.withSpan("desktop.computerUse.acquire"));

  const currentMcpConfiguration = Ref.get(connectionRef).pipe(
    Effect.map((connection): DesktopMcpServerConfiguration | undefined => {
      const mcp = connection?.mcp;
      if (!mcp) return undefined;
      return {
        command: mcp.command,
        args: [...mcp.args],
        environment: {
          ...Object.fromEntries(mcp.environment.map(({ name, value }) => [name, value])),
          HOME: driverHomeDirectory,
        },
      };
    }),
  );

  return DesktopComputerUse.of({
    acquire,
    getState,
    requestPermissions,
    currentMcpConfiguration,
  });
});

export const layer = Layer.effect(DesktopComputerUse, make);

export const layerTest = (input?: {
  readonly state?: Partial<Omit<DesktopComputerUseState, "enabled">>;
  readonly onRequestPermissions?: Effect.Effect<void>;
  readonly mcpConfiguration?: DesktopMcpServerConfiguration;
}) =>
  Layer.succeed(
    DesktopComputerUse,
    DesktopComputerUse.of({
      acquire: Effect.void,
      getState: (enabled) =>
        Effect.succeed({
          enabled,
          available: input?.state?.available ?? true,
          running: input?.state?.running ?? false,
          accessibilityPermission: input?.state?.accessibilityPermission ?? null,
          screenRecordingPermission: input?.state?.screenRecordingPermission ?? null,
        }),
      requestPermissions: (input?.onRequestPermissions ?? Effect.void).pipe(Effect.as(null)),
      currentMcpConfiguration: Effect.succeed(input?.mcpConfiguration),
    }),
  );
