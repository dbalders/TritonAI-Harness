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
  assertManagedCodexIdle,
  assertManagedCodexLockOwnership,
  withManagedCodexLock,
} from "./managedCodexLock.ts";
import {
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";

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

export class ManagedCodexUpdateError extends Schema.TaggedError<ManagedCodexUpdateError>()(
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

      return Effect.succeed({
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
      });
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

/**
 * Finds the Node.js runtime and npm the Installer's POSIX launcher pins.
 * Installer machines rarely have node or npm on the app's PATH, so staging and
 * verification must not depend on it. Returns null for launchers without a
 * pinned runtime, which keep using npm from PATH.
 */
const resolvePosixManagedTools = Effect.fn("managedCodexUpdate.resolvePosixManagedTools")(
  function* (installation: TritonAiManagedCodexInstallation) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const launcher = yield* fs.readFileString(installation.binaryPath);
    // Read the Installer's pinned paths as data; never execute the launcher.
    const nodeRelative = /^NODE_BIN="\$SCRIPT_DIR\/([^"\r\n]+)"$/mu.exec(launcher)?.[1];
    if (!nodeRelative) return null;
    const entryRelative =
      /^exec "\$NODE_BIN" "\$SCRIPT_DIR\/\.\.\/(lib\/node_modules\/@openai\/codex\/bin\/codex\.js)" "\$@"$/mu.exec(
        launcher,
      )?.[1];
    if (!entryRelative) {
      return yield* updateError(
        "The managed launcher is unsupported. Repair it with TritonAI Installer.",
      );
    }
    const nodeBinary = path.resolve(installation.installRoot, "bin", ...nodeRelative.split("/"));
    const nodeHome = path.dirname(path.dirname(nodeBinary));
    const expectedNodeRoot = path.join(
      path.dirname(path.dirname(installation.installRoot)),
      "node",
    );
    const npmCli = path.join(nodeHome, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (
      path.dirname(nodeHome) !== expectedNodeRoot ||
      !/^node-v\d+\.\d+\.\d+-(?:darwin|linux)-(?:x64|arm64)$/u.test(path.basename(nodeHome)) ||
      path.relative(nodeHome, nodeBinary) !== path.join("bin", "node") ||
      !(yield* fs.exists(nodeBinary)) ||
      !(yield* fs.exists(npmCli))
    ) {
      return yield* updateError(
        "The managed Node.js/npm runtime is missing. Repair it with TritonAI Installer.",
      );
    }
    return { nodeBinary, npmCli, entrySegments: entryRelative.split("/") };
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
  yield* recoverTritonAiManagedCodex(input);
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
    return currentVersion;
  }

  const runtimeRoot = path.dirname(installation.installRoot);
  const windowsTools = installation.windows
    ? yield* resolveWindowsManagedTools(installation)
    : null;
  const managedTools = windowsTools ?? (yield* resolvePosixManagedTools(installation));
  const installationName = path.basename(installation.installRoot);
  // Windows can briefly retain an executable's file mapping after --version exits.
  const retryFileOperation = <A>(
    operation: Effect.Effect<A, PlatformError.PlatformError>,
    requireOwnership = false,
  ) =>
    (requireOwnership
      ? assertManagedCodexLockOwnership().pipe(Effect.andThen(operation))
      : operation
    ).pipe(
      Effect.retry({
        while: (error) => {
          if (error._tag === "ManagedCodexLockError") return false;
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
      command: managedTools?.nodeBinary ?? "npm",
      args: [
        ...(managedTools ? [managedTools.npmCli] : []),
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
      command: managedTools?.nodeBinary ?? stagedBinaryPath,
      args: managedTools
        ? [path.join(stagedInstallRoot, ...managedTools.entrySegments), "--version"]
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

  const activate = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* assertManagedCodexLockOwnership();
      yield* retryFileOperation(fs.rename(installation.installRoot, backupInstallRoot), true);
      backedUp = true;
      yield* assertManagedCodexLockOwnership();
      yield* retryFileOperation(fs.rename(stagedInstallRoot, installation.installRoot), true);
      activated = true;
      const activeVersionResult = yield* restore(
        runCheckedCommand(
          input.run,
          {
            command: installation.binaryPath,
            args: ["--version"],
            timeout: "30 seconds",
            maxOutputBytes: 8 * 1024,
            outputMode: "truncate",
          },
          "The activated Codex package failed verification.",
        ),
      );
      const activeVersion = parseCodexCliVersion(commandOutput(activeVersionResult));
      if (activeVersion !== stagedVersion) {
        return yield* updateError("The activated Codex package did not match the staged version.");
      }
      yield* assertManagedCodexLockOwnership();
      verified = true;
      return activeVersion;
    }),
  );

  return yield* withManagedCodexLock(
    runtimeRoot,
    Effect.gen(function* () {
      yield* assertManagedCodexIdle(runtimeRoot);
      // A second updater may have finished while this package downloaded.
      const current = yield* runCheckedCommand(
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
      const version = parseCodexCliVersion(commandOutput(current));
      if (version && compareSemverVersions(version, approvedVersion) >= 0) return version;
      return yield* activate.pipe(
        Effect.mapError((cause) => updateError("The managed Codex update was rolled back.", cause)),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            verified = false;
            yield* assertManagedCodexLockOwnership();
            if (activated) {
              yield* retryFileOperation(
                fs.remove(installation.installRoot, { recursive: true, force: true }),
                true,
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
              yield* assertManagedCodexLockOwnership();
              yield* retryFileOperation(
                fs.rename(backupInstallRoot, installation.installRoot),
                true,
              ).pipe(
                Effect.mapError((rollbackCause) =>
                  updateError(
                    `Rollback failed. The previous engine is retained at ${backupInstallRoot}.`,
                    rollbackCause,
                  ),
                ),
              );
              backedUp = false;
            }
            return yield* Effect.failCause(cause);
          }).pipe(Effect.uninterruptible),
        ),
      );
    }),
  );
});

/** Recover a retained pre-update engine even when process termination skipped finalizers. */
export const recoverManagedCodexUnderLock = Effect.fn("recoverManagedCodexUnderLock")(
  function* (input: { readonly binaryPath: string; readonly run: ManagedCodexCommandRunner }) {
    const installation = resolveTritonAiManagedCodexInstallation(input.binaryPath);
    if (!installation) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeRoot = path.dirname(installation.installRoot);
    if (!(yield* fs.exists(runtimeRoot))) return;
    const backups = (yield* fs.readDirectory(runtimeRoot))
      .filter((entry) => entry.startsWith(".tritonai-codex-backup."))
      .sort();
    if (backups.length === 0) return;
    const working = (binaryPath: string) =>
      input
        .run({
          command: binaryPath,
          args: ["--version"],
          timeout: "5 seconds",
          maxOutputBytes: 8 * 1024,
        })
        .pipe(
          Effect.map(
            (result) =>
              result.code === 0 &&
              !result.timedOut &&
              parseCodexCliVersion(commandOutput(result)) !== null,
          ),
          Effect.orElseSucceed(() => false),
        );
    if ((yield* fs.exists(installation.binaryPath)) && (yield* working(installation.binaryPath)))
      return;
    yield* assertManagedCodexIdle(runtimeRoot);
    for (const backup of backups) {
      const backupRoot = path.join(runtimeRoot, backup, path.basename(installation.installRoot));
      const backupBinary = path.join(backupRoot, ...installation.binaryRelativeSegments);
      if (!(yield* fs.exists(backupBinary))) continue;
      const linked = yield* Effect.forEach(
        [path.join(runtimeRoot, backup), backupRoot, backupBinary],
        (target) =>
          fs.readLink(target).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
      );
      if (linked.some(Boolean)) continue;
      // Keep an incomplete active engine until the recovered launcher is verified.
      const quarantine = yield* fs.makeTempDirectory({
        directory: runtimeRoot,
        prefix: ".tritonai-codex-stage.recovery.",
      });
      const displaced = path.join(quarantine, path.basename(installation.installRoot));
      let moved = false;
      let restored = false;
      const recovered = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* assertManagedCodexLockOwnership();
          if (yield* fs.exists(installation.installRoot)) {
            yield* fs.rename(installation.installRoot, displaced);
            moved = true;
          }
          yield* assertManagedCodexLockOwnership();
          yield* fs.rename(backupRoot, installation.installRoot);
          restored = true;
          if (!(yield* restore(working(installation.binaryPath)))) {
            return yield* updateError("The retained Codex engine failed recovery verification.");
          }
          yield* assertManagedCodexLockOwnership();
        }),
      ).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* assertManagedCodexLockOwnership();
            if (restored) yield* fs.rename(installation.installRoot, backupRoot);
            yield* assertManagedCodexLockOwnership();
            if (moved) yield* fs.rename(displaced, installation.installRoot);
          }).pipe(Effect.orDie),
        ),
        Effect.result,
      );
      if (recovered._tag === "Success") {
        yield* fs.remove(quarantine, { recursive: true, force: true });
        yield* fs.remove(path.join(runtimeRoot, backup), { recursive: true, force: true });
        return;
      }
      yield* fs.remove(quarantine, { recursive: true, force: true });
    }
    return yield* updateError(
      "No retained Codex engine could be recovered. Run TritonAI Installer to repair it.",
    );
  },
);

export const recoverTritonAiManagedCodex = Effect.fn("recoverTritonAiManagedCodex")(
  function* (input: { readonly binaryPath: string; readonly run: ManagedCodexCommandRunner }) {
    const installation = resolveTritonAiManagedCodexInstallation(input.binaryPath);
    if (!installation) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimeRoot = path.dirname(installation.installRoot);
    if (!(yield* fs.exists(runtimeRoot))) return;
    yield* withManagedCodexLock(runtimeRoot, recoverManagedCodexUnderLock(input));
  },
);

export const managedCodexUpdateCommandName = MANAGED_CODEX_UPDATE_COMMAND;
