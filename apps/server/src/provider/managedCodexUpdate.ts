import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ProcessRunInput, ProcessRunOutput, ProcessRunner } from "../processRunner.ts";
import {
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilitiesResolver,
} from "./providerMaintenance.ts";

const MANAGED_CODEX_ROOT_MARKER = "/.agents/ucsd/runtime/codex/";
const MANAGED_CODEX_DIRECTORY = /^openai-codex-[a-z0-9][a-z0-9._-]*$/u;
const MANAGED_CODEX_UPDATE_COMMAND = "managed-codex-update";
const MANAGED_CODEX_UPDATE_LOCK = "tritonai-managed-codex";
const CODEX_VERSION = /(?:codex-cli|codex)\s+(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)/iu;

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
      if (!managedInstallation || input.serverEntryPath.trim().length === 0) {
        return input.fallback.resolve(options);
      }

      return makeProviderMaintenanceCapabilities({
        provider: input.provider,
        packageName: input.packageName,
        updateExecutable: input.executablePath,
        updateArgs: [
          input.serverEntryPath,
          MANAGED_CODEX_UPDATE_COMMAND,
          managedInstallation.binaryPath,
        ],
        updateLockKey: MANAGED_CODEX_UPDATE_LOCK,
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

  const runtimeRoot = path.dirname(installation.installRoot);
  const installationName = path.basename(installation.installRoot);
  const stagingContainer = yield* fs.makeTempDirectoryScoped({
    directory: runtimeRoot,
    prefix: ".tritonai-codex-stage.",
  });
  const backupContainer = yield* fs.makeTempDirectoryScoped({
    directory: runtimeRoot,
    prefix: ".tritonai-codex-backup.",
  });
  const stagedInstallRoot = path.join(stagingContainer, installationName);
  const stagedBinaryPath = path.join(stagedInstallRoot, ...installation.binaryRelativeSegments);
  const backupInstallRoot = path.join(backupContainer, installationName);

  yield* runCheckedCommand(
    input.run,
    {
      command: "npm",
      args: [
        "install",
        "-g",
        "--prefix",
        stagedInstallRoot,
        "--no-fund",
        "--no-audit",
        "@openai/codex@latest",
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

  const stagedVersionResult = yield* runCheckedCommand(
    input.run,
    {
      command: stagedBinaryPath,
      args: ["--version"],
      timeout: "30 seconds",
      maxOutputBytes: 8 * 1024,
      outputMode: "truncate",
    },
    "The staged Codex package failed verification.",
  );
  const stagedVersion = parseCodexCliVersion(commandOutput(stagedVersionResult));
  if (!stagedVersion) {
    return yield* updateError("The staged Codex package returned an invalid version.");
  }

  // npm's generated launcher follows ambient PATH. Retain the Installer's
  // launcher so the activated package remains pinned to the managed Node runtime.
  yield* fs.remove(stagedBinaryPath, { force: true });
  yield* fs.copyFile(installation.binaryPath, stagedBinaryPath);
  if (!installation.windows) yield* fs.chmod(stagedBinaryPath, 0o755);

  let backedUp = false;
  let activated = false;
  const activate = Effect.gen(function* () {
    yield* fs.rename(installation.installRoot, backupInstallRoot);
    backedUp = true;
    yield* fs.rename(stagedInstallRoot, installation.installRoot);
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
    return activeVersion;
  });

  return yield* activate.pipe(
    Effect.catch((cause) =>
      Effect.gen(function* () {
        if (activated) {
          yield* fs
            .remove(installation.installRoot, { recursive: true, force: true })
            .pipe(
              Effect.mapError((rollbackCause) => updateError("Rollback failed.", rollbackCause)),
            );
        }
        if (backedUp) {
          yield* fs
            .rename(backupInstallRoot, installation.installRoot)
            .pipe(
              Effect.mapError((rollbackCause) => updateError("Rollback failed.", rollbackCause)),
            );
        }
        return yield* updateError("The managed Codex update was rolled back.", cause);
      }),
    ),
  );
});

export const managedCodexUpdateCommandName = MANAGED_CODEX_UPDATE_COMMAND;
