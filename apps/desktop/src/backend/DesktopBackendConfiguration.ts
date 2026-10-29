import * as NodeOS from "node:os";

import {
  LEGACY_T3CODE_HOME_ENV,
  isTritonAiNightlyVersion,
  resolveTritonAiDesktopIdentity,
  TRITONAI_API_KEY_ENV,
  TRITONAI_FRONTIER_API_KEY_ENV,
  TRITONAI_HOME_ENV,
  TRITONAI_ONPREM_API_KEY_ENV,
} from "@t3tools/contracts";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopSecretStoreKey from "./DesktopSecretStoreKey.ts";
import * as DesktopCliShim from "../app/DesktopCliShim.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopComputerUse from "../computerUse/DesktopComputerUse.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTritonAiApiKey from "../settings/DesktopTritonAiApiKey.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";

export class DesktopBackendObservabilitySettingsReadError extends Schema.TaggedError<DesktopBackendObservabilitySettingsReadError>()(
  "DesktopBackendObservabilitySettingsReadError",
  {
    settingsPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read persisted backend observability settings at ${this.settingsPath}.`;
  }
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  {
    readonly resolvePrimary: Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    readonly resolveWsl: (input: {
      readonly port: number;
      readonly distro: string | null;
    }) => Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    readonly resolvePrimaryLabel: Effect.Effect<string>;
    readonly currentBootstrapToken: Effect.Effect<string, PlatformError.PlatformError>;
  }
>()("@t3tools/desktop/backend/DesktopBackendConfiguration") {}

interface BackendObservabilitySettings {
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpMetricsUrl: Option.Option<string>;
  readonly otlpLogsUrl: Option.Option<string>;
}

const emptyBackendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: Option.none(),
  otlpMetricsUrl: Option.none(),
  otlpLogsUrl: Option.none(),
};

const TRITONAI_CREDENTIAL_ENV_NAMES = new Set([
  TRITONAI_API_KEY_ENV,
  TRITONAI_ONPREM_API_KEY_ENV,
  TRITONAI_FRONTIER_API_KEY_ENV,
]);

const DESKTOP_BACKEND_ENV_NAMES = [
  TRITONAI_HOME_ENV,
  LEGACY_T3CODE_HOME_ENV,
  "T3CODE_PORT",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_HOST",
  "T3CODE_DESKTOP_WS_URL",
  "T3CODE_DESKTOP_LAN_ACCESS",
  "T3CODE_DESKTOP_LAN_HOST",
  "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
  "T3CODE_TAILSCALE_SERVE",
  "T3CODE_TAILSCALE_SERVE_PORT",
] as const;

// Windows forwards these variables into WSL only through WSLENV.
const WSL_FORWARDED_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TRITONAI_API_KEY",
  TRITONAI_ONPREM_API_KEY_ENV,
  TRITONAI_FRONTIER_API_KEY_ENV,
  "UCSD_AI_BASE_URL",
  "TRITONAI_ACCOUNT_SERVICE_URL",
  "TRITONAI_ACCOUNT_ALLOW_INSECURE_LOOPBACK",
  "T3CODE_TELEMETRY_ENABLED",
  // Otherwise the WSL server keeps exporting to endpoints from the bootstrap.
  "T3CODE_OTEL_SDK_DISABLED",
  "OTEL_SDK_DISABLED",
  "T3CODE_OTLP_HEADERS",
  "T3CODE_OTLP_PROTOCOL",
  // Untranslated T3 URLs must override bootstrap endpoints inside WSL, as they do on Windows.
  "T3CODE_OTLP_TRACES_URL",
  "T3CODE_OTLP_METRICS_URL",
  "T3CODE_OTLP_LOGS_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;

const WSL_SERVER_SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const nodeBinDirOf = (nodePath: string): string => {
  const lastSlash = nodePath.lastIndexOf("/");
  return lastSlash > 0 ? nodePath.slice(0, lastSlash) : "/usr/bin";
};

const backendChildEnvPatch = (): Record<string, string | undefined> =>
  Object.fromEntries(DESKTOP_BACKEND_ENV_NAMES.map((name) => [name, undefined]));

function parseShellExportLine(line: string): readonly [string, string] | null {
  const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
  if (!match?.[1]) return null;
  let value = match[2] ?? "";
  if (value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1).replaceAll("'\\''", "'");
  } else if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\(["\\$`])/gu, "$1");
  }
  return [match[1], value] as const;
}

// The Installer writes literal assignments on Windows. Do not evaluate PowerShell
// or import its PATH expression; provider runtime discovery owns executable paths.
function parsePowerShellEnvironmentLine(line: string): readonly [string, string] | null {
  const match = line.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'((?:[^']|'')*)'$/iu);
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : [match[1].toUpperCase(), match[2].replaceAll("''", "'")];
}

const readUcsdEnvironmentFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const isWindows = environment.platform === "win32";
  const envFilePath = environment.path.join(
    environment.homeDirectory,
    ".agents",
    "ucsd",
    isWindows ? "env.ps1" : "env",
  );
  const contents = yield* fileSystem.readFileString(envFilePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning("Failed to read UCSD installer environment file.").pipe(
              Effect.annotateLogs({
                component: "desktop-backend-configuration",
                path: envFilePath,
                error: cause.message || String(cause),
              }),
              Effect.as(Option.none<string>()),
            ),
    }),
  );
  if (Option.isNone(contents)) return {};

  return Object.fromEntries(
    contents.value
      .split(/\r?\n/u)
      .map((line) =>
        (isWindows ? parsePowerShellEnvironmentLine : parseShellExportLine)(line.trim()),
      )
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
});

// Restore Installer tool directories for Dock/Finder/update launches after the user’s PATH.
// If the env file provides none, use the newest usable staged Node and Codex runtimes.
const DECLARED_MANAGED_PATH_PATTERN = /^'([^']*)':\$(?:PATH|\{PATH\})$/u;
const MANAGED_NODE_RUNTIME_PATTERN = /^node-v(\d+)\.(\d+)\.(\d+)-([a-z0-9]+)-([a-z0-9]+)$/u;
const MANAGED_CODEX_RUNTIME_PATTERN = /^openai-codex-(\d+)\.(\d+)\.(\d+)$/u;

function declaredManagedPathEntries(rawPath: string | undefined): ReadonlyArray<string> {
  const declared = rawPath === undefined ? null : DECLARED_MANAGED_PATH_PATTERN.exec(rawPath);
  return declared?.[1] === undefined
    ? []
    : declared[1].split(":").filter((entry) => entry.startsWith("/"));
}

// A missing tool folder is normal; anything else (e.g. permissions) is logged and treated as
// absent, so a damaged runtime can never stop the backend from starting.
function absentUnlessLogged<A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  fallback: A,
  path: string,
): Effect.Effect<A, never, R> {
  return effect.pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(fallback)
          : Effect.logWarning("Could not inspect an Installer-managed tool folder.").pipe(
              Effect.annotateLogs({
                component: "desktop-backend-configuration",
                path,
                error: cause.message || String(cause),
              }),
              Effect.as(fallback),
            ),
    }),
  );
}

const statManagedPath = Effect.fn("desktop.backendConfiguration.statManagedPath")(function* (
  target: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* absentUnlessLogged(
    fileSystem.stat(target).pipe(Effect.asSome),
    Option.none<FileSystem.File.Info>(),
    target,
  );
});

const isExecutableFile = Effect.fn("desktop.backendConfiguration.isExecutableFile")(function* (
  file: string,
) {
  // stat follows symlinks, so npm/npx links into lib/node_modules are checked at their target.
  const info = yield* statManagedPath(file);
  return Option.exists(info, (value) => value.type === "File" && (value.mode & 0o111) !== 0);
});

const newestUsableRuntimeBin = Effect.fn("desktop.backendConfiguration.newestUsableRuntimeBin")(
  function* (
    root: string,
    pattern: RegExp,
    accepts: (match: RegExpExecArray) => boolean,
    commands: ReadonlyArray<string>,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const entries = yield* absentUnlessLogged<ReadonlyArray<string>, never>(
      fileSystem.readDirectory(root),
      [],
      root,
    );
    const runtimes = entries
      .flatMap((name) => {
        const match = pattern.exec(name);
        return match === null || !accepts(match)
          ? []
          : [{ name, version: match.slice(1, 4).map(Number) }];
      })
      .sort((left, right) => compareVersionParts(right.version, left.version));
    for (const runtime of runtimes) {
      const binDirectory = environment.path.join(root, runtime.name, "bin");
      let usable = true;
      for (const command of commands) {
        usable &&= yield* isExecutableFile(environment.path.join(binDirectory, command));
      }
      if (usable) return Option.some(binDirectory);
    }
    return Option.none<string>();
  },
);

const resolveManagedPathEntries = Effect.fn("desktop.backendConfiguration.resolveManagedPath")(
  function* (ucsdEnvironment: Record<string, string>) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    // Windows still starts through the Installer's PowerShell launcher, which owns its PATH.
    if (environment.platform === "win32") return [] as ReadonlyArray<string>;
    let candidates = declaredManagedPathEntries(ucsdEnvironment.PATH);
    if (candidates.length === 0) {
      const runtimeRoot = environment.path.join(
        environment.homeDirectory,
        ".agents",
        "ucsd",
        "runtime",
      );
      const codexBin = yield* newestUsableRuntimeBin(
        environment.path.join(runtimeRoot, "codex"),
        MANAGED_CODEX_RUNTIME_PATTERN,
        () => true,
        ["codex"],
      );
      const nodeBin = yield* newestUsableRuntimeBin(
        environment.path.join(runtimeRoot, "node"),
        MANAGED_NODE_RUNTIME_PATTERN,
        (match) => match[4] === environment.platform && match[5] === environment.processArch,
        ["node", "npm", "npx"],
      );
      candidates = [...Option.toArray(codexBin), ...Option.toArray(nodeBin)];
    }
    const existing: Array<string> = [];
    for (const candidate of candidates) {
      const info = yield* statManagedPath(candidate);
      if (Option.exists(info, (value) => value.type === "Directory")) existing.push(candidate);
    }
    return existing as ReadonlyArray<string>;
  },
);

function compareVersionParts(left: ReadonlyArray<number>, right: ReadonlyArray<number>): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// Append without rebuilding the inherited PATH: an empty entry means the current directory.
function appendPathEntry(currentPath: string | undefined, entry: string): string {
  if (currentPath === undefined) return entry;
  // An explicitly empty PATH means the current directory; keep it ahead of the managed entry.
  if (currentPath.length === 0) return `:${entry}`;
  return currentPath.split(":").includes(entry) ? currentPath : `${currentPath}:${entry}`;
}

function ucsdEnvironmentFallback(ucsdEnvironment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ucsdEnvironment).filter(([name]) => {
      const inherited = process.env[name];
      return inherited === undefined || inherited.length === 0;
    }),
  );
}

function withoutTritonAiCredentials(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !TRITONAI_CREDENTIAL_ENV_NAMES.has(name)),
  );
}

function resolveTritonAiCredentialEnvironment(
  ucsdEnvironment: Record<string, string>,
  desktopOverride: Option.Option<DesktopTritonAiApiKey.TritonAiCredentialBundle>,
): Record<string, string | undefined> {
  return Option.match(desktopOverride, {
    onSome: DesktopTritonAiApiKey.credentialEnvironmentPatch,
    onNone: () => {
      const installerCredentials =
        DesktopTritonAiApiKey.credentialBundleFromEnvironment(ucsdEnvironment);
      return installerCredentials === null
        ? {}
        : DesktopTritonAiApiKey.credentialEnvironmentPatch(installerCredentials);
    },
  });
}

const getWslEnvEntryName = (entry: string): string => {
  const slashIndex = entry.indexOf("/");
  return slashIndex === -1 ? entry : entry.slice(0, slashIndex);
};

const mergeWslEnv = (
  existingWslEnv: string | undefined,
  forwardedEnvNames: ReadonlyArray<string>,
): string | undefined => {
  const existing = existingWslEnv?.trim() ?? "";

  const seenNames = new Set(
    existing
      .split(":")
      .map((entry) => getWslEnvEntryName(entry.trim()))
      .filter((name) => name.length > 0),
  );

  const additions = forwardedEnvNames.filter((name) => !seenNames.has(name));

  // Preserve empty segments and duplicates in the user's WSLENV; only append required variables.
  const parts = [existing, ...additions].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(":") : undefined;
};

const logBackendObservabilitySettingsReadFailure = (
  settingsPath: string,
  cause: PlatformError.PlatformError,
) => {
  const error = new DesktopBackendObservabilitySettingsReadError({ settingsPath, cause });
  return Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-backend-configuration",
      error,
    }),
  );
};

function resourceMonitorBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

const resolveResourceMonitorPath = Effect.fn(
  "desktop.backendConfiguration.resolveResourceMonitorPath",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const binaryName = resourceMonitorBinaryName(environment.platform);
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/release",
          binaryName,
        ),
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/debug",
          binaryName,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, "resource-monitor", binaryName)]
      : environment.resolveResourcePathCandidates(
          environment.path.join("resource-monitor", binaryName),
        );

  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }

  return Option.none<string>();
});

const readPersistedBackendObservabilitySettings = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : logBackendObservabilitySettingsReadFailure(environment.serverSettingsPath, cause).pipe(
              Effect.as(Option.none()),
            ),
    }),
  );
  if (Option.isNone(raw)) {
    return emptyBackendObservabilitySettings;
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return {
    otlpTracesUrl: Option.fromNullishOr(parsed.otlpTracesUrl),
    otlpMetricsUrl: Option.fromNullishOr(parsed.otlpMetricsUrl),
    otlpLogsUrl: Option.fromNullishOr(parsed.otlpLogsUrl),
  };
});

const readBackendObservabilitySettings = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const persisted = yield* readPersistedBackendObservabilitySettings;
  return {
    otlpTracesUrl: Option.orElse(environment.otlpTracesUrl, () => persisted.otlpTracesUrl),
    otlpMetricsUrl: Option.orElse(environment.otlpMetricsUrl, () => persisted.otlpMetricsUrl),
    otlpLogsUrl: Option.orElse(environment.otlpLogsUrl, () => persisted.otlpLogsUrl),
  } satisfies BackendObservabilitySettings;
});

interface SharedBootstrapInput {
  readonly bootstrapToken: string;
  readonly secretStoreKeys: readonly [string, ...string[]];
  readonly legacySecretFingerprints: Readonly<Record<string, string>>;
  readonly bootstrapSecret: string;
  readonly observabilitySettings: BackendObservabilitySettings;
}

type WslPreflightRuntime =
  | {
      readonly kind: "executable";
      readonly entryPath: string;
    }
  | {
      readonly kind: "node-script";
      // Launch the exact Node path probed with node-pty, even if later PATH lookup would resolve another version.
      readonly nodePath: string;
      readonly linuxEntryPath: string;
    };

interface WslPreflightSuccess {
  readonly _tag: "Ready";
  readonly runningDistro: string;
  readonly windowsEntryPath: string;
  readonly runtime: WslPreflightRuntime;
  readonly resolvedPath: string;
  readonly runtimeId?: string;
}

interface WslPreflightFailure {
  readonly _tag: "Failed";
  readonly reason: string;
  readonly fatal: boolean;
  readonly retryLimit?: number;
}

const WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT = 12;
const WSL_RUNTIME_ARCHIVE_NAME = "wsl-runtime.tar.gz";
const WSL_RUNTIME_ARCHIVE_HASH_NAME = `${WSL_RUNTIME_ARCHIVE_NAME}.sha256`;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

const parseWslRuntimeArchiveHash = (value: string): string | null => {
  const trimmed = value.trim();
  return SHA256_HEX_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

type FailedNodePtyResult = Extract<
  DesktopWslEnvironment.EnsureWslNodePtyResult,
  { readonly ok: false }
>;

const runWslPreflight = Effect.fn("desktop.backendConfiguration.wslPreflight")(function* (input: {
  readonly distro: string | null;
  readonly runtimeArchive: DesktopWslEnvironment.WslRuntimeArchive | null;
  readonly allowBuild: boolean;
}): Effect.fn.Return<
  WslPreflightSuccess | WslPreflightFailure,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWslEnvironment.DesktopWslEnvironment
  | DesktopWslServerTree.DesktopWslServerTree
  | FileSystem.FileSystem
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const wslEnv = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const wslServerTree = yield* DesktopWslServerTree.DesktopWslServerTree;
  const fileSystem = yield* FileSystem.FileSystem;

  const wslAvailable = yield* wslEnv.isAvailable;
  if (!wslAvailable) {
    return {
      _tag: "Failed",
      reason: "WSL is not available on this system",
      fatal: false,
    } as const;
  }

  const distroProbe = yield* wslEnv.probeDistros.pipe(
    Effect.map((distros) => ({ _tag: "Success", distros }) as const),
    Effect.catch((error) => Effect.succeed({ _tag: "Failure", error } as const)),
  );
  if (distroProbe._tag === "Failure") {
    return {
      _tag: "Failed",
      reason: `Unable to list WSL distributions: ${distroProbe.error.message}`,
      fatal: false,
    } as const;
  }

  const installedDistros = distroProbe.distros;
  const runningDistro = input.distro
    ? (installedDistros.find(
        (installed) => installed.name.toLowerCase() === input.distro?.toLowerCase(),
      )?.name ?? null)
    : (installedDistros.find((installed) => installed.isDefault)?.name ?? null);
  if (runningDistro === null) {
    return {
      _tag: "Failed",
      reason: input.distro
        ? `WSL distro is not installed: ${input.distro}`
        : installedDistros.length === 0
          ? "WSL has no installed distributions"
          : "WSL has no default distribution",
      fatal: true,
    } as const;
  }

  const nodePtyOptions = {
    allowBuild: input.allowBuild,
    nodeEngineRange: serverPackageJson.engines.node,
  };
  const failedNodePty = (result: FailedNodePtyResult) =>
    ({
      _tag: "Failed",
      reason: `WSL node-pty unavailable: ${result.reason}`,
      fatal: result.fatal,
      ...(result.retryLimit === undefined ? {} : { retryLimit: result.retryLimit }),
    }) as const;

  const resolveMountedAppRoot = Effect.gen(function* () {
    const serverTree = yield* wslServerTree.ensure;
    if (!serverTree.ok) {
      return { ok: false, reason: serverTree.reason, fatal: serverTree.fatal } as const;
    }
    const windowsEntryPath = environment.path.join(serverTree.root, "apps/server/dist/bin.mjs");
    const entryExists = yield* fileSystem
      .exists(windowsEntryPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!entryExists) {
      return {
        ok: false,
        reason: `missing server entry at ${windowsEntryPath}`,
        fatal: true,
      } as const;
    }
    const mountedAppRoot = yield* wslEnv.windowsToWslPath(runningDistro, serverTree.root);
    return Option.isNone(mountedAppRoot)
      ? ({
          ok: false,
          reason: `wslpath conversion failed for ${serverTree.root}`,
          fatal: false,
        } as const)
      : ({ ok: true, windowsEntryPath, linuxAppRoot: mountedAppRoot.value } as const);
  });

  let stagedFailure: { readonly runtimeId?: string; readonly reason: string } | undefined;
  const failedStaged = (failure: { readonly reason: string }) =>
    ({
      _tag: "Failed",
      reason: `WSL runtime unavailable: ${failure.reason}`,
      fatal: true,
    }) as const;

  if (input.runtimeArchive !== null) {
    const runtime = yield* wslEnv.prepareRuntime(runningDistro, input.runtimeArchive);
    if (runtime.ok) {
      // Staged runtimes bundle Node and node-pty; provider PATH discovery must not require them.
      const stagedProbe = yield* wslEnv.probeRuntime(runningDistro, runtime.linuxAppRoot);
      if (stagedProbe.ok) {
        yield* wslServerTree.cleanupLegacy;
        return {
          _tag: "Ready",
          runningDistro,
          windowsEntryPath: environment.backendEntryPath,
          runtime: { kind: "executable", entryPath: `${runtime.linuxAppRoot}/t3` },
          resolvedPath: stagedProbe.resolvedPath,
          runtimeId: input.runtimeArchive.runtimeId,
        } as const;
      }
      yield* Effect.logWarning(
        "The staged WSL runtime did not start; retrying from the mounted server tree.",
        { reason: stagedProbe.reason },
      );
      stagedFailure = { runtimeId: input.runtimeArchive.runtimeId, reason: stagedProbe.reason };
    } else {
      stagedFailure = { reason: runtime.reason };
      yield* Effect.logWarning(
        "Could not stage the WSL runtime; launching from the mounted server tree instead.",
        { reason: runtime.reason },
      );
    }
  }

  const mounted = yield* resolveMountedAppRoot;
  if (!mounted.ok) {
    return stagedFailure && mounted.fatal
      ? failedStaged(stagedFailure)
      : ({ _tag: "Failed", reason: mounted.reason, fatal: mounted.fatal } as const);
  }

  const nodePtyResult = yield* wslEnv.ensureNodePty(
    runningDistro,
    mounted.linuxAppRoot,
    nodePtyOptions,
  );
  if (!nodePtyResult.ok) {
    // Only substitute a staged failure for a fatal mounted failure; transient /mnt failures must remain retryable.
    return stagedFailure && nodePtyResult.fatal
      ? failedStaged(stagedFailure)
      : failedNodePty(nodePtyResult);
  }

  if (stagedFailure?.runtimeId) {
    yield* wslEnv.invalidateRuntime(runningDistro, stagedFailure.runtimeId);
  }

  return {
    _tag: "Ready",
    runningDistro,
    windowsEntryPath: mounted.windowsEntryPath,
    runtime: {
      kind: "node-script",
      nodePath: nodePtyResult.nodePath,
      linuxEntryPath: `${mounted.linuxAppRoot}/apps/server/dist/bin.mjs`,
    },
    resolvedPath: nodePtyResult.resolvedPath,
  } as const;
});

// In WSL2 mirrored mode, eth0 matches a host IP; use loopback for the renderer.
const isLocalHostIpv4 = (ip: string): boolean => {
  const interfaces = NodeOS.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const entry of list) {
      const family = String(entry.family);
      if ((family === "IPv4" || family === "4") && entry.address === ip) return true;
    }
  }
  return false;
};

const buildObservabilityFragment = (observabilitySettings: BackendObservabilitySettings) => ({
  ...Option.match(observabilitySettings.otlpTracesUrl, {
    onNone: () => ({}),
    onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
  }),
  ...Option.match(observabilitySettings.otlpMetricsUrl, {
    onNone: () => ({}),
    onSome: (otlpMetricsUrl) => ({ otlpMetricsUrl }),
  }),
  ...Option.match(observabilitySettings.otlpLogsUrl, {
    onNone: () => ({}),
    onSome: (otlpLogsUrl) => ({ otlpLogsUrl }),
  }),
});

const resolvePrimaryStartConfig = Effect.fn("desktop.backendConfiguration.resolvePrimary")(
  function* (
    input: SharedBootstrapInput & {
      readonly resourceMonitorPath: Option.Option<string>;
      readonly cliPath: Option.Option<string>;
      readonly shellEnvironmentPrepared: boolean;
    },
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    | DesktopComputerUse.DesktopComputerUse
    | DesktopAppSettings.DesktopAppSettings
    | DesktopEnvironment.DesktopEnvironment
    | DesktopServerExposure.DesktopServerExposure
    | FileSystem.FileSystem
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;
    const ucsdEnvironment = yield* readUcsdEnvironmentFile;
    const managedPathEntries = yield* resolveManagedPathEntries(ucsdEnvironment);
    const tritonAiCredentialOverride = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride;
    const tritonAiCredentialEnvironment = resolveTritonAiCredentialEnvironment(
      ucsdEnvironment,
      tritonAiCredentialOverride,
    );
    const computerUse = yield* DesktopComputerUse.DesktopComputerUse;
    const computerUseMcp = yield* computerUse.currentMcpConfiguration;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const computerUseState = yield* computerUse
      .getState((yield* appSettings.get).computerUseEnabled)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not read computer-use startup status", error).pipe(
            Effect.as(undefined),
          ),
        ),
      );

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: backendExposure.port,
      t3Home: environment.baseDir,
      host: backendExposure.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      secretStoreKeys: input.secretStoreKeys,
      legacySecretFingerprints: input.legacySecretFingerprints,
      desktopBootstrapSecret: input.bootstrapSecret,
      shellEnvironmentPrepared: input.shellEnvironmentPrepared,
      tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
      tailscaleServePort: backendExposure.tailscaleServePort,
      desktopTelemetryFd: 4,
      desktopTelemetryControlFd: 5,
      desktopBrowserFd: 6,
      desktopBrowserControlFd: 7,
      ...Option.match(input.resourceMonitorPath, {
        onNone: () => ({}),
        onSome: (resourceMonitorPath) => ({ resourceMonitorPath }),
      }),
      ...(computerUseMcp === undefined ? {} : { computerUseMcp }),
      ...(computerUseState === undefined ? {} : { computerUseState }),
      ...buildObservabilityFragment(input.observabilitySettings),
    };

    return {
      executablePath: process.execPath,
      // Packaged builds have a separate cache; --require prevents cache settings leaking to provider subprocesses.
      args: [
        ...(environment.isPackaged ? ["--require", environment.compileCachePath] : []),
        environment.backendEntryPath,
        "--bootstrap-fd",
        "3",
      ],
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...ucsdEnvironmentFallback(withoutTritonAiCredentials(ucsdEnvironment)),
        ...tritonAiCredentialEnvironment,
        ...backendChildEnvPatch(),
        ...(managedPathEntries.length === 0
          ? {}
          : { PATH: managedPathEntries.reduce(appendPathEntry, process.env.PATH) }),
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_CLI_PATH: Option.getOrUndefined(input.cliPath),
      },
      extendEnv: true,
      bootstrap,
      bootstrapDelivery: "fd3",
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
      preflightFailure: Option.none(),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);

const resolveWslStartConfig = Effect.fn("desktop.backendConfiguration.resolveWsl")(function* (
  input: SharedBootstrapInput & {
    readonly port: number;
    readonly distro: string | null;
  },
): Effect.fn.Return<
  DesktopBackendManager.DesktopBackendStartConfig,
  PlatformError.PlatformError,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWslEnvironment.DesktopWslEnvironment
  | DesktopWslServerTree.DesktopWslServerTree
  | ElectronDialog.ElectronDialog
  | FileSystem.FileSystem
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const ucsdEnvironment = yield* readUcsdEnvironmentFile;
  const tritonAiCredentialOverride = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride;
  const installerCredentials =
    DesktopTritonAiApiKey.credentialBundleFromEnvironment(ucsdEnvironment);
  const hasManagedCredentialBundle =
    Option.isSome(tritonAiCredentialOverride) || installerCredentials !== null;
  const tritonAiCredentialEnvironment = resolveTritonAiCredentialEnvironment(
    ucsdEnvironment,
    tritonAiCredentialOverride,
  );

  // wslhost loopback forwarding is unreliable on some Windows hosts; advertise the WSL IP instead.
  const wslBindHost = "0.0.0.0";

  // The archive is the primary packaged WSL path: it installs directly into
  // the distro's ext4 filesystem. The server.asar extraction service is only
  // consulted lazily if the archive is unavailable or cannot be staged.
  const archivePath = environment.path.join(environment.resourcesPath, WSL_RUNTIME_ARCHIVE_NAME);
  const archiveHashPath = environment.path.join(
    environment.resourcesPath,
    WSL_RUNTIME_ARCHIVE_HASH_NAME,
  );

  const hasArchive = environment.isPackaged
    ? yield* fileSystem.exists(archivePath).pipe(Effect.orElseSucceed(() => false))
    : false;
  const archiveHash = hasArchive
    ? yield* fileSystem.readFileString(archiveHashPath).pipe(
        Effect.map(parseWslRuntimeArchiveHash),
        Effect.orElseSucceed(() => null),
      )
    : null;
  if (hasArchive && archiveHash === null) {
    yield* Effect.logWarning(
      "Ignoring the WSL runtime archive because its SHA-256 identity is missing or invalid; launching from the mounted server tree instead.",
      { hashPath: archiveHashPath },
    );
  }

  const preflight = yield* runWslPreflight({
    distro: input.distro,
    runtimeArchive:
      archiveHash === null
        ? null
        : {
            windowsPath: archivePath,
            runtimeId: `sha256-${archiveHash}`,
            sha256: archiveHash,
          },
    allowBuild: !environment.isPackaged,
  });

  // Pin the preflight distro so a default change cannot race backend startup.
  const runningDistro = preflight._tag === "Ready" ? preflight.runningDistro : null;
  const distroForConfig = runningDistro ?? input.distro;

  let legacySecretFingerprints: Readonly<Record<string, string>> = {};
  if (preflight._tag === "Ready") {
    const inventory = yield* wslEnvironment.readSecretFiles(
      distroForConfig,
      Option.isSome(environment.devServerUrl),
      environment.appVersion,
    );
    if (!inventory.ok) {
      return yield* PlatformError.systemError({
        _tag: "InvalidData",
        module: "DesktopBackendConfiguration",
        method: "resolveWslSecretStore",
        description: inventory.reason,
      });
    }
    const decodedKeys = yield* Effect.forEach(input.secretStoreKeys, (encoded) =>
      Effect.fromResult(Base64.decode(encoded)).pipe(
        Effect.mapError(() =>
          PlatformError.systemError({
            _tag: "InvalidData",
            module: "DesktopBackendConfiguration",
            method: "resolveWslSecretStore",
            description: "The protected desktop secret-store key is invalid.",
          }),
        ),
      ),
    );
    legacySecretFingerprints = yield* DesktopSecretStoreKey.authorizeLegacySecretValues(
      inventory.files,
      decodedKeys as [Uint8Array, ...Uint8Array[]],
      distroForConfig === null
        ? "the default WSL distribution"
        : `WSL distribution ${distroForConfig}`,
    );
  }

  const bootstrap = {
    mode: "desktop" as const,
    noBrowser: true,
    port: input.port,
    // Expand Nightly's home inside Linux; never pass the Windows baseDir,
    // which would share the primary backend's SQLite database through /mnt/c.
    ...(!environment.isDevelopment && isTritonAiNightlyVersion(environment.appVersion)
      ? { t3Home: `~/${resolveTritonAiDesktopIdentity(environment.appVersion).homeDirName}` }
      : {}),
    host: wslBindHost,
    desktopBootstrapToken: input.bootstrapToken,
    desktopBootstrapSecret: input.bootstrapSecret,
    secretStoreKeys: input.secretStoreKeys,
    // A WSL backend has a distro-local credential store. Authorizations
    // captured for the Windows-native store must never be reused here.
    legacySecretFingerprints,
    // PortSchema rejects 0, so when tailscale serve is disabled we still
    // need a valid number in this slot. The backend reads tailscaleServePort
    // only when tailscaleServeEnabled is true, so the actual value here is
    // inert.
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    // The packaged resource-monitor sidecar is a Windows executable and cannot
    // run inside the Linux WSL backend. Keep the field absent instead of passing
    // an unusable `/mnt/.../*.exe` path; WSL resource telemetry is unavailable.
    ...buildObservabilityFragment(input.observabilitySettings),
  };

  // Resolve the selected distro's IPv4 address. In mirrored mode the distro
  // reports a host interface, so use loopback instead; a failed probe also
  // falls back to loopback and preserves the previous behavior.
  const distroIp = yield* wslEnvironment.getDistroIp(distroForConfig);
  const usesSharedNetworkStack = Option.match(distroIp, {
    onNone: () => false,
    onSome: (ip) => isLocalHostIpv4(ip),
  });
  const rendererHost = usesSharedNetworkStack
    ? "127.0.0.1"
    : Option.getOrElse(distroIp, () => "127.0.0.1");
  const httpBaseUrl = new URL(`http://${rendererHost}:${input.port}`);

  const distroArgs = distroForConfig ? ["-d", distroForConfig] : [];
  const forwardedEnv: Record<string, string> = {};
  const forwardedEnvNames: string[] = [];
  for (const name of WSL_FORWARDED_ENV_NAMES) {
    const isCredential = TRITONAI_CREDENTIAL_ENV_NAMES.has(name);
    const value =
      hasManagedCredentialBundle && isCredential
        ? tritonAiCredentialEnvironment[name]
        : process.env[name] && process.env[name].length > 0
          ? process.env[name]
          : ucsdEnvironment[name];
    if (value !== undefined && value.length > 0) {
      forwardedEnv[name] = value;
      forwardedEnvNames.push(name);
    }
  }

  // Exclude host TRITONAI_HOME/T3CODE_HOME from WSL to avoid sharing the Windows database
  // and environment ID through /mnt/c.
  const parentEnvWithoutManagedHome: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === TRITONAI_HOME_ENV || key === LEGACY_T3CODE_HOME_ENV) continue;
    parentEnvWithoutManagedHome[key] = value;
  }
  const wslEnv = mergeWslEnv(parentEnvWithoutManagedHome.WSLENV, forwardedEnvNames);

  const baseConfig = {
    executablePath: "wsl.exe",
    entryPath:
      preflight._tag === "Ready" ? preflight.windowsEntryPath : environment.backendEntryPath,
    cwd: environment.backendCwd,
    env: {
      ...withoutTritonAiCredentials(ucsdEnvironment),
      ...parentEnvWithoutManagedHome,
      ...backendChildEnvPatch(),
      ...tritonAiCredentialEnvironment,
      ...forwardedEnv,
      ...(wslEnv !== undefined ? { WSLENV: wslEnv } : {}),
    },
    // env is already a complete process.env minus managed home variables; pass it
    // verbatim instead of letting the spawner re-merge process.env on top.
    extendEnv: false,
    bootstrap,
    bootstrapDelivery: "stdin" as const,
    httpBaseUrl,
    captureOutput: true,
    ...(runningDistro !== null ? { runningDistro } : {}),
  };

  // Explicit --dev-url keeps WSL state in dev/ rather than userdata/.
  const devUrlArgs = Option.match(environment.devServerUrl, {
    onNone: () => [] as ReadonlyArray<string>,
    onSome: (url) => ["--dev-url", url.href],
  });

  if (preflight._tag === "Failed") {
    const retryLimit =
      preflight.retryLimit ?? (preflight.fatal ? undefined : WSL_TRANSIENT_PREFLIGHT_RETRY_LIMIT);
    return {
      ...baseConfig,
      args: [...distroArgs, "--", "node", "--version"],
      preflightFailure: Option.some({
        reason: preflight.reason,
        fatal: preflight.fatal,
        ...(retryLimit === undefined ? {} : { retryLimit }),
      }),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  }

  // wsl.exe --exec omits the login-shell PATH needed to find provider CLIs and npm.
  const runtime = preflight.runtime;
  const launchPath =
    runtime.kind === "executable"
      ? `${WSL_SERVER_SYSTEM_PATH}:${preflight.resolvedPath}`
      : `${nodeBinDirOf(runtime.nodePath)}:${WSL_SERVER_SYSTEM_PATH}:${preflight.resolvedPath}`;
  const command =
    runtime.kind === "executable"
      ? [runtime.entryPath]
      : [runtime.nodePath, runtime.linuxEntryPath];

  return {
    ...baseConfig,
    args: [
      ...distroArgs,
      "--exec",
      "env",
      `PATH=${launchPath}`,
      ...command,
      "--bootstrap-fd",
      "0",
      ...devUrlArgs,
    ],
    preflightFailure: Option.none(),
    ...(preflight.runtimeId === undefined ? {} : { wslRuntimeId: preflight.runtimeId }),
  } satisfies DesktopBackendManager.DesktopBackendStartConfig;
});

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const wslServerTree = yield* DesktopWslServerTree.DesktopWslServerTree;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const computerUse = yield* DesktopComputerUse.DesktopComputerUse;
  const crypto = yield* Crypto.Crypto;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  // Use SynchronizedRef: concurrent primary/WSL resolution can yield during randomBytes
  // and otherwise mint different secrets, breaking the shared renderer token.
  const secretRef = yield* SynchronizedRef.make(Option.none<string>());
  const getOrCreateBootstrapSecret = SynchronizedRef.modifyEffect(secretRef, (current) =>
    Option.match(current, {
      onSome: (secret) => Effect.succeed([secret, current] as const),
      onNone: () =>
        crypto.randomBytes(32).pipe(
          Effect.map((bytes) => {
            const secret = Hex.encode(bytes);
            return [secret, Option.some(secret)] as const;
          }),
        ),
    }),
  );
  const secretStoreKeysRef = yield* SynchronizedRef.make(
    Option.none<DesktopSecretStoreKey.DesktopSecretStoreKeyMaterial>(),
  );
  const getOrCreateSecretStoreKeys = SynchronizedRef.modifyEffect(secretStoreKeysRef, (current) =>
    Option.match(current, {
      onSome: (keys) => Effect.succeed([keys, current] as const),
      onNone: () =>
        DesktopSecretStoreKey.resolve().pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(ElectronDialog.ElectronDialog, dialog),
          Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, safeStorage),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.map((keys) => [keys, Option.some(keys)] as const),
        ),
    }),
  );

  const sharedInputs = Effect.gen(function* () {
    const bootstrapSecret = yield* getOrCreateBootstrapSecret;
    const bootstrapToken = currentDesktopBootstrapToken(
      bootstrapSecret,
      yield* Clock.currentTimeMillis,
    );
    const secretStoreKeyMaterial = yield* getOrCreateSecretStoreKeys;
    const observabilitySettings = yield* readBackendObservabilitySettings.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return {
      bootstrapToken,
      secretStoreKeys: secretStoreKeyMaterial.keys,
      legacySecretFingerprints: secretStoreKeyMaterial.legacySecretFingerprints,
      bootstrapSecret,
      observabilitySettings,
    } satisfies SharedBootstrapInput;
  });

  const buildWslPrimaryConfig = Effect.gen(function* () {
    const backendExposure = yield* serverExposure.backendConfig;
    const persistedSettings = yield* settings.get;
    const shared = yield* sharedInputs;
    yield* wslEnvironment.preWarm(persistedSettings.wslDistro);
    return yield* resolveWslStartConfig({
      ...shared,
      port: backendExposure.port,
      distro: persistedSettings.wslDistro,
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
      Effect.provideService(DesktopWslServerTree.DesktopWslServerTree, wslServerTree),
      Effect.provideService(ElectronDialog.ElectronDialog, dialog),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });

  const buildWindowsPrimaryConfig = Effect.gen(function* () {
    const shared = yield* sharedInputs;
    const resourceMonitorPath = yield* resolveResourceMonitorPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const cliPath = yield* DesktopCliShim.install.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    const shellEnvironmentPrepared = yield* shellEnvironment.installIntoProcess;
    return yield* resolvePrimaryStartConfig({
      ...shared,
      resourceMonitorPath,
      cliPath,
      shellEnvironmentPrepared,
    }).pipe(
      Effect.provideService(DesktopComputerUse.DesktopComputerUse, computerUse),
      Effect.provideService(DesktopAppSettings.DesktopAppSettings, settings),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });

  // Resolve on each restart so toggling wsl-only takes effect without recreating the pool.
  const describePrimary = Effect.gen(function* () {
    const persistedSettings = yield* settings.get;
    const wslRequested = persistedSettings.wslOnly && persistedSettings.wslBackendEnabled;
    // When WSL is unavailable its controls are hidden; fall back to Windows to keep recovery possible.
    const useWsl = wslRequested && (yield* wslEnvironment.isAvailable);
    return { useWsl, wslRequested, distro: persistedSettings.wslDistro };
  });

  const currentBootstrapToken = Effect.gen(function* () {
    const secret = yield* getOrCreateBootstrapSecret;
    return currentDesktopBootstrapToken(secret, yield* Clock.currentTimeMillis);
  });

  return DesktopBackendConfiguration.of({
    currentBootstrapToken,
    resolvePrimary: Effect.gen(function* () {
      const { useWsl, wslRequested } = yield* describePrimary;
      if (useWsl) {
        return yield* buildWslPrimaryConfig;
      }
      if (wslRequested) {
        yield* Effect.logWarning(
          "WSL-only backend requested but WSL is unavailable; starting the Windows primary instead.",
        );
      }
      return yield* buildWindowsPrimaryConfig;
    }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimary")),
    resolvePrimaryLabel: Effect.gen(function* () {
      const { useWsl, distro } = yield* describePrimary;
      if (!useWsl) {
        return environment.platform === "win32" ? "Windows" : "Local environment";
      }
      return distro ? `WSL (${distro})` : "WSL";
    }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimaryLabel")),
    // The span options depend on each request's port and distro.
    resolveWsl: Effect.fnUntraced(
      function* (input) {
        const shared = yield* sharedInputs;
        return yield* resolveWslStartConfig({ ...shared, ...input }).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
          Effect.provideService(DesktopWslServerTree.DesktopWslServerTree, wslServerTree),
          Effect.provideService(ElectronDialog.ElectronDialog, dialog),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.withSpan("desktop.backendConfiguration.resolveWsl", {
            attributes: { port: input.port, distro: input.distro ?? null },
          }),
        ),
    ),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
