import { ProviderDriverKind } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { managedConfig } from "../managedPolicy.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import type { ProcessRunInput, ProcessRunOutput, ProcessRunner } from "../processRunner.ts";
import {
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "./providerMaintenance.ts";

const MANAGED_CODEX_ROOT_MARKER = "/.agents/ucsd/runtime/codex/";
const MANAGED_CODEX_DIRECTORY = /^openai-codex-[a-z0-9][a-z0-9._-]*$/u;
const MANAGED_CODEX_UPDATE_COMMAND = "managed-codex-update";
const MANAGED_CODEX_UPDATE_LOCK = "tritonai-managed-codex";
export const ManagedCodexApprovedVersion = Context.Reference<string | null>(
  "@t3tools/server/ManagedCodexApprovedVersion",
  {
    defaultValue: () => managedConfig.provider.approvedCodexVersion ?? null,
  },
);

const CODEX_VERSION = /(?:codex-cli|codex)\s+(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)/iu;

export function isTritonAiManagedCodexMaintenanceCapabilities(
  capabilities: ProviderMaintenanceCapabilities,
): boolean {
  return capabilities.approvedVersion !== undefined;
}

export interface TritonAiManagedCodexInstallation {
  readonly binaryPath: string;
  readonly installRoot: string;
  readonly binaryRelativeSegments: ReadonlyArray<string>;
  readonly windows: boolean;
}

export class ManagedCodexUpdateError extends Schema.TaggedErrorClass<ManagedCodexUpdateError>()(
  "ManagedCodexUpdateError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

function updateError(message: string, cause?: unknown): ManagedCodexUpdateError {
  return new ManagedCodexUpdateError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function resolveTritonAiManagedCodexInstallation(
  binaryPath: string,
): TritonAiManagedCodexInstallation | null {
  const normalized = normalizeCommandPath(binaryPath);
  const markerIndex = normalized.lastIndexOf(MANAGED_CODEX_ROOT_MARKER);
  if (markerIndex < 0) return null;

  const tail = normalized.slice(markerIndex + MANAGED_CODEX_ROOT_MARKER.length);
  const separatorIndex = tail.indexOf("/");
  if (separatorIndex <= 0) return null;
  const directory = tail.slice(0, separatorIndex);
  if (!MANAGED_CODEX_DIRECTORY.test(directory)) return null;

  const relativeBinaryPath = tail.slice(separatorIndex);
  const windows = relativeBinaryPath === "/codex.cmd";
  if (!windows && relativeBinaryPath !== "/bin/codex") return null;

  return {
    binaryPath,
    installRoot: binaryPath.slice(0, -relativeBinaryPath.length),
    binaryRelativeSegments: windows ? ["codex.cmd"] : ["bin", "codex"],
    windows,
  };
}

export function parseCodexCliVersion(output: string): string | null {
  return CODEX_VERSION.exec(output)?.[1] ?? null;
}

export function makeTritonAiManagedCodexMaintenanceResolver(input: {
  readonly provider: ProviderDriverKind;
  readonly packageName: string;
  readonly fallback: ProviderMaintenanceCapabilitiesResolver;
  readonly executablePath: string;
  readonly serverEntryPath: string;
}): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (options) => {
      const managedInstallation = [
        options?.binaryPath,
        options?.resolvedCommandPath,
        options?.realCommandPath,
      ]
        .filter((candidate): candidate is string => typeof candidate === "string")
        .map(resolveTritonAiManagedCodexInstallation)
        .find((candidate) => candidate !== null);
      if (!managedInstallation) {
        return input.fallback.resolve(options);
      }

      return {
        ...makeProviderMaintenanceCapabilities({
          provider: input.provider,
          packageName: input.packageName,
          updateExecutable: input.serverEntryPath.trim() ? input.executablePath : null,
          updateArgs: [
            input.serverEntryPath,
            MANAGED_CODEX_UPDATE_COMMAND,
            managedInstallation.binaryPath,
          ],
          updateLockKey: MANAGED_CODEX_UPDATE_LOCK,
        }),
        approvedVersion: managedConfig.provider.approvedCodexVersion ?? null,
      };
    },
  };
}

type ManagedCodexCommandRunner = ProcessRunner["Service"]["run"];

const runCheckedCommand = Effect.fn("managedCodexUpdate.runCheckedCommand")(function* (
  run: ManagedCodexCommandRunner,
  input: ProcessRunInput,
  failureMessage: string,
) {
  const result = yield* run(input).pipe(
    Effect.mapError((cause) => updateError(failureMessage, cause)),
  );
  if (result.timedOut) return yield* updateError(`${failureMessage} The command timed out.`);
  if (result.code !== 0) {
    const detail = [result.stderr, result.stdout]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 2_000);
    return yield* updateError(
      `${failureMessage} The command exited with code ${String(result.code)}.${detail ? `\n${detail}` : ""}`,
    );
  }
  return result;
});

function commandOutput(result: ProcessRunOutput): string {
  return `${result.stdout}\n${result.stderr}`;
}

const resolveWindowsManagedTools = Effect.fn("managedCodexUpdate.resolveWindowsManagedTools")(
  function* (installation: TritonAiManagedCodexInstallation) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const launcher = yield* fs.readFileString(installation.binaryPath);
    // Read the Installer's pinned paths as data; never execute environment scripts.
    const nodeRelative = /^set "NODE_BIN=%SCRIPT_DIR%([^"\r\n]+)"\r?$/mu.exec(launcher)?.[1];
    const entryRelative =
      /^"%NODE_BIN%" "%SCRIPT_DIR%((?:lib\\)?node_modules\\@openai\\codex\\bin\\codex\.js)" %\*\r?$/mu.exec(
        launcher,
      )?.[1];
    if (!nodeRelative || !entryRelative) {
      return yield* updateError(
        "The managed Windows launcher is unsupported. Repair it with TritonAI Installer.",
      );
    }
    const nodeBinary = path.resolve(installation.installRoot, ...nodeRelative.split("\\"));
    const nodeHome = path.dirname(nodeBinary);
    const expectedNodeRoot = path.join(
      path.dirname(path.dirname(installation.installRoot)),
      "node",
    );
    const npmCli = path.join(nodeHome, "node_modules", "npm", "bin", "npm-cli.js");
    if (
      path.dirname(nodeHome) !== expectedNodeRoot ||
      !/^node-v\d+\.\d+\.\d+-win-(?:x64|arm64)$/u.test(path.basename(nodeHome)) ||
      path.basename(nodeBinary) !== "node.exe" ||
      !(yield* fs.exists(nodeBinary)) ||
      !(yield* fs.exists(npmCli))
    ) {
      return yield* updateError(
        "The managed Node.js/npm runtime is missing. Repair it with TritonAI Installer.",
      );
    }
    return { nodeBinary, npmCli, entrySegments: entryRelative.split("\\") };
  },
);

export const updateTritonAiManagedCodex = Effect.fn(
  "managedCodexUpdate.updateTritonAiManagedCodex",
)(function* (input: { readonly binaryPath: string; readonly run: ManagedCodexCommandRunner }) {
  const installation = resolveTritonAiManagedCodexInstallation(input.binaryPath);
  if (!installation) {
    return yield* updateError(
      "The configured Codex binary is not a TritonAI-managed runtime and cannot use this updater.",
    );
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(installation.binaryPath))) {
    return yield* updateError("The managed Codex launcher is missing.");
  }
  const installationIsSymlink = yield* fs.readLink(installation.installRoot).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  const launcherIsSymlink = yield* fs.readLink(installation.binaryPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (installationIsSymlink || launcherIsSymlink) {
    return yield* updateError("The managed Codex runtime must not be a symbolic link.");
  }

  const approvedVersion = yield* ManagedCodexApprovedVersion;
  if (!approvedVersion || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(approvedVersion)) {
    return yield* updateError("No valid approved Codex version is configured.");
  }
  const currentResult = yield* runCheckedCommand(
    input.run,
    {
      command: installation.binaryPath,
      args: ["--version"],
      timeout: "30 seconds",
      maxOutputBytes: 8 * 1024,
      outputMode: "truncate",
    },
    "The installed Codex version could not be verified.",
  );
  const currentVersion = parseCodexCliVersion(commandOutput(currentResult));
  if (!currentVersion) return yield* updateError("The installed Codex version is invalid.");
  if (compareSemverVersions(currentVersion, approvedVersion) >= 0) {
    return yield* updateError(
      "The installed Codex version already meets or exceeds the approved version.",
    );
  }

  const runtimeRoot = path.dirname(installation.installRoot);
  const windowsTools = installation.windows
    ? yield* resolveWindowsManagedTools(installation)
    : null;
  const installationName = path.basename(installation.installRoot);
  // Windows can briefly retain an executable's file mapping after --version exits.
  const retryFileOperation = <A>(operation: Effect.Effect<A, PlatformError.PlatformError>) =>
    operation.pipe(
      Effect.retry({
        while: (error) => {
          const cause = error.reason.cause;
          return (
            installation.windows &&
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            ["EPERM", "EACCES", "EBUSY"].includes(String(cause.code))
          );
        },
        schedule: Schedule.spaced("250 millis"),
        times: 40,
      }),
    );
  let backedUp = false;
  let activated = false;
  let verified = false;
  const makeTemporaryDirectory = Effect.fn("managedCodexUpdate.makeTemporaryDirectory")(function* (
    prefix: string,
    shouldRemove = () => true,
  ) {
    return yield* Effect.acquireRelease(
      fs.makeTempDirectory({ directory: runtimeRoot, prefix }),
      (directory) =>
        shouldRemove()
          ? retryFileOperation(fs.remove(directory, { recursive: true, force: true })).pipe(
              Effect.orDie,
            )
          : Effect.void,
    );
  });
  const stagingContainer = yield* makeTemporaryDirectory(".tritonai-codex-stage.");
  const backupContainer = yield* makeTemporaryDirectory(
    ".tritonai-codex-backup.",
    () => !backedUp || verified,
  );
  const stagedInstallRoot = path.join(stagingContainer, installationName);
  const stagedBinaryPath = path.join(stagedInstallRoot, ...installation.binaryRelativeSegments);
  const backupInstallRoot = path.join(backupContainer, installationName);

  yield* runCheckedCommand(
    input.run,
    {
      command: windowsTools?.nodeBinary ?? "npm",
      args: [
        ...(windowsTools ? [windowsTools.npmCli] : []),
        "install",
        "-g",
        "--prefix",
        stagedInstallRoot,
        "--no-fund",
        "--no-audit",
        `@openai/codex@${approvedVersion}`,
      ],
      timeout: "4 minutes",
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
      truncatedMarker: "\n[output truncated]",
    },
    "The managed Codex package could not be staged.",
  );
  if (!(yield* fs.exists(stagedBinaryPath))) {
    return yield* updateError("The staged Codex package did not contain its launcher.");
  }

  // Installer archives use lib/node_modules even on Windows. npm's Windows
  // prefix uses node_modules; retain the layout expected by the pinned launcher.
  if (windowsTools?.entrySegments[0] === "lib") {
    yield* fs.makeDirectory(path.join(stagedInstallRoot, "lib"), { recursive: true });
    yield* fs.rename(
      path.join(stagedInstallRoot, "node_modules"),
      path.join(stagedInstallRoot, "lib", "node_modules"),
    );
  }

  const stagedVersionResult = yield* runCheckedCommand(
    input.run,
    {
      command: windowsTools?.nodeBinary ?? stagedBinaryPath,
      args: windowsTools
        ? [path.join(stagedInstallRoot, ...windowsTools.entrySegments), "--version"]
        : ["--version"],
      timeout: "30 seconds",
      maxOutputBytes: 8 * 1024,
      outputMode: "truncate",
    },
    "The staged Codex package failed verification.",
  );
  const stagedVersion = parseCodexCliVersion(commandOutput(stagedVersionResult));
  if (stagedVersion !== approvedVersion) {
    return yield* updateError("The staged Codex package did not match the approved version.");
  }

  // npm's generated launcher follows ambient PATH. Retain the Installer's
  // launcher so the activated package remains pinned to the managed Node runtime.
  yield* fs.remove(stagedBinaryPath, { force: true });
  yield* fs.copyFile(installation.binaryPath, stagedBinaryPath);
  if (!installation.windows) yield* fs.chmod(stagedBinaryPath, 0o755);

  const activate = Effect.gen(function* () {
    yield* retryFileOperation(fs.rename(installation.installRoot, backupInstallRoot));
    backedUp = true;
    yield* retryFileOperation(fs.rename(stagedInstallRoot, installation.installRoot));
    activated = true;
    const activeVersionResult = yield* runCheckedCommand(
      input.run,
      {
        command: installation.binaryPath,
        args: ["--version"],
        timeout: "30 seconds",
        maxOutputBytes: 8 * 1024,
        outputMode: "truncate",
      },
      "The activated Codex package failed verification.",
    );
    const activeVersion = parseCodexCliVersion(commandOutput(activeVersionResult));
    if (activeVersion !== stagedVersion) {
      return yield* updateError("The activated Codex package did not match the staged version.");
    }
    verified = true;
    return activeVersion;
  });

  return yield* activate.pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        if (activated) {
          yield* retryFileOperation(
            fs.remove(installation.installRoot, { recursive: true, force: true }),
          ).pipe(
            Effect.mapError((rollbackCause) =>
              updateError(
                `Rollback failed. The previous engine is retained at ${backupInstallRoot}.`,
                rollbackCause,
              ),
            ),
          );
        }
        if (backedUp) {
          yield* retryFileOperation(fs.rename(backupInstallRoot, installation.installRoot)).pipe(
            Effect.mapError((rollbackCause) =>
              updateError(
                `Rollback failed. The previous engine is retained at ${backupInstallRoot}.`,
                rollbackCause,
              ),
            ),
          );
          backedUp = false;
        }
        return yield* updateError("The managed Codex update was rolled back.", cause);
      }),
    ),
  );
});

export const managedCodexUpdateCommandName = MANAGED_CODEX_UPDATE_COMMAND;
