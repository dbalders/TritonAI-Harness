import {
  EmbeddedCuaDriverHost,
  EmbeddedDriverHostOptions,
  EmbeddedEnvironmentVariable,
  EmbeddedPermissionMode,
  type EmbeddedDriverConnection,
} from "@trycua/cua-driver/embedded";
import {
  hasRequiredMacOSPermissions,
  openMacOSScreenRecordingSettings,
  requestMacOSPermissions,
} from "@trycua/cua-driver/electron";
import type { DesktopMcpServerConfiguration } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const CUA_DRIVER_PATH_ENV = "TRITONAI_CUA_DRIVER_PATH";
const CUA_DRIVER_CHILD_ENVIRONMENT = [
  EmbeddedEnvironmentVariable.new({ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }),
  EmbeddedEnvironmentVariable.new({ name: "CUA_DRIVER_RS_UPDATE_CHECK", value: "false" }),
];

type EmbeddedHost = ReturnType<typeof EmbeddedCuaDriverHost.withOptions> & {
  readonly uniffiDestroy?: () => void;
};

class DesktopComputerUseRuntimeError extends Schema.TaggedErrorClass<DesktopComputerUseRuntimeError>()(
  "DesktopComputerUseRuntimeError",
  {
    operation: Schema.Literals(["permissions", "open-settings", "start", "stop"]),
    cause: Schema.Defect(),
  },
) {}

let activeConnection: EmbeddedDriverConnection | undefined;

export function resolveCuaDriverBinaryPath(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  configuredPath: string | undefined = process.env[CUA_DRIVER_PATH_ENV],
): string {
  const override = configuredPath?.trim();
  if (override && !environment.isPackaged) return environment.path.resolve(override);
  const executableName = environment.platform === "win32" ? "cua-driver.exe" : "cua-driver";
  return environment.path.join(environment.resourcesPath, "cua-driver", executableName);
}

export function currentComputerUseMcpConfiguration(): DesktopMcpServerConfiguration | undefined {
  const mcp = activeConnection?.mcp;
  if (!mcp) return undefined;
  return {
    command: mcp.command,
    args: [...mcp.args],
    environment: Object.fromEntries(mcp.environment.map(({ name, value }) => [name, value])),
  };
}

function destroyHost(host: EmbeddedHost): void {
  host.uniffiDestroy?.();
}

export const acquire = Effect.fn("desktop.computerUse.acquire")(function* (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
) {
  const attempt = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const binaryPath = resolveCuaDriverBinaryPath(environment);

    if (!(yield* fileSystem.exists(binaryPath))) {
      yield* Effect.logWarning(
        environment.isPackaged
          ? `Bundled Cua Driver is missing at ${binaryPath}; computer use is unavailable.`
          : `Cua Driver is unavailable. Set ${CUA_DRIVER_PATH_ENV} to a local cua-driver executable.`,
      );
      return;
    }

    if (environment.platform === "darwin") {
      const permissions = yield* Effect.try({
        try: requestMacOSPermissions,
        catch: (cause) => new DesktopComputerUseRuntimeError({ operation: "permissions", cause }),
      });
      if (!hasRequiredMacOSPermissions(permissions)) {
        if (!permissions.screenRecording) {
          yield* Effect.tryPromise({
            try: openMacOSScreenRecordingSettings,
            catch: (cause) =>
              new DesktopComputerUseRuntimeError({ operation: "open-settings", cause }),
          });
        }
        yield* Effect.logWarning(
          "Computer use is waiting for macOS Accessibility and Screen Recording permissions; restart TritonAI Harness after granting them.",
        );
        return;
      }
    }

    const host = EmbeddedCuaDriverHost.withOptions(
      EmbeddedDriverHostOptions.new({
        binaryPath,
        hostBundleId: environment.appUserModelId,
        permissionMode: EmbeddedPermissionMode.Standard,
        approveSessionPolicy: false,
        dangerouslyBypassApprovals: false,
        environment: CUA_DRIVER_CHILD_ENVIRONMENT,
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
            Effect.sync(() => {
              activeConnection = undefined;
              destroyHost(host);
            }),
          ),
        ),
    );

    activeConnection = connection;
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
});
