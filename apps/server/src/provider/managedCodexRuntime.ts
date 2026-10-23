import { resolveCommandPath } from "@t3tools/shared/shell";
import { Platform as HostProcessPlatform } from "@t3tools/shared/HostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ProcessRunner } from "../processRunner.ts";
import {
  parseCodexCliVersion,
  resolveTritonAiManagedCodexInstallation,
  recoverTritonAiManagedCodex,
  recoverManagedCodexUnderLock,
} from "./managedCodexUpdate.ts";
import { acquireManagedCodexLease } from "./managedCodexLock.ts";

const decodePackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.Literal("@openai/codex"), version: Schema.String }),
  ),
);

export class ManagedCodexRuntimeError extends Schema.TaggedError<ManagedCodexRuntimeError>()(
  "ManagedCodexRuntimeError",
  { binaryPath: Schema.String },
) {
  override get message(): string {
    return `Codex could not start at '${this.binaryPath}', and no working TritonAI-managed runtime was found. Run TritonAI Installer to install or repair Codex, or configure a working Codex executable.`;
  }
}

/** Resolve an executable only; profile settings, credentials and CODEX_HOME stay with the caller. */
export const resolveManagedCodexBinary = Effect.fn("resolveManagedCodexBinary")(function* (input: {
  readonly binaryPath: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly run: ProcessRunner["Service"]["run"];
}) {
  let requested = input.binaryPath.trim() || "codex";
  const fs = yield* FileSystem.FileSystem;
  {
    const command = yield* resolveCommandPath(requested, { env: input.environment }).pipe(
      Effect.provideService(HostProcessPlatform, input.platform),
    );
    if (command) {
      const resolved = yield* fs.realPath(command).pipe(Effect.orElseSucceed(() => command));
      if (resolveTritonAiManagedCodexInstallation(resolved)) requested = resolved;
    }
  }
  const configuredInstallation = resolveTritonAiManagedCodexInstallation(requested);
  // An explicit custom command is intentional, even when it is broken.
  if (requested !== "codex" && !configuredInstallation) return requested;

  const run: ProcessRunner["Service"]["run"] = (command) =>
    input.run({ ...command, env: input.environment });
  const workingVersion = Effect.fn("managedCodexRuntime.workingVersion")(
    function* (command: string) {
      const lease = yield* leaseManagedCodexRuntime(command, run);
      const result = yield* run({
        command,
        args: ["--version"],
        timeout: "5 seconds",
        maxOutputBytes: 8 * 1024,
        ...(lease ? { onSpawn: (pid: number) => lease.bindChild(pid).pipe(Effect.orDie) } : {}),
      });
      return result.code === 0 && !result.timedOut ? parseCodexCliVersion(result.stdout) : null;
    },
    Effect.scoped,
    Effect.orElseSucceed(() => null),
  );

  const path = yield* Path.Path;
  const runtimeRoot = path.join(input.homeDirectory, ".agents", "ucsd", "runtime", "codex");
  if (yield* workingVersion(requested)) return requested;
  if (!configuredInstallation) {
    // A fresh profile has no configured path; retained backups still identify their installation.
    const backups = yield* fs.readDirectory(runtimeRoot).pipe(Effect.orElseSucceed(() => []));
    for (const entry of backups.filter((name) => name.startsWith(".tritonai-codex-backup."))) {
      const roots = yield* fs
        .readDirectory(path.join(runtimeRoot, entry))
        .pipe(Effect.orElseSucceed(() => []));
      for (const root of roots) {
        const binaryPath = path.join(
          runtimeRoot,
          root,
          ...(input.platform === "win32" ? ["codex.cmd"] : ["bin", "codex"]),
        );
        yield* recoverTritonAiManagedCodex({ binaryPath, run }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Skipped an unavailable retained Codex engine", {
              binaryPath,
              cause,
            }),
          ),
        );
      }
    }
  }
  const entries = yield* fs.readDirectory(runtimeRoot).pipe(Effect.orElseSucceed(() => []));
  const candidates: Array<{ binaryPath: string; version: string }> = [];
  for (const entry of entries) {
    const installRoot = path.join(runtimeRoot, entry);
    const binaryPath =
      input.platform === "win32"
        ? path.join(installRoot, "codex.cmd")
        : path.join(installRoot, "bin", "codex");
    // Excludes the Installer/updater's staging and rollback directories.
    if (binaryPath === requested || !resolveTritonAiManagedCodexInstallation(binaryPath)) continue;
    const packageRoots =
      input.platform === "win32"
        ? [path.join(installRoot, "node_modules"), path.join(installRoot, "lib", "node_modules")]
        : [path.join(installRoot, "lib", "node_modules")];
    for (const packageRoot of packageRoots) {
      const metadata = yield* fs
        .readFileString(path.join(packageRoot, "@openai", "codex", "package.json"))
        .pipe(
          Effect.flatMap(decodePackage),
          Effect.orElseSucceed(() => null),
        );
      if (!metadata || !parseSemver(metadata.version)) continue;
      // Engine updates retain the install directory name. Sort by the actual package version.
      candidates.push({ binaryPath, version: metadata.version });
      break;
    }
  }
  candidates.sort(
    (left, right) =>
      compareSemverVersions(right.version, left.version) ||
      left.binaryPath.localeCompare(right.binaryPath),
  );
  for (const candidate of candidates) {
    const version = yield* workingVersion(candidate.binaryPath);
    if (version && compareSemverVersions(version, candidate.version) === 0) {
      return candidate.binaryPath;
    }
  }
  return yield* new ManagedCodexRuntimeError({ binaryPath: requested });
});

/** The caller's scope must outlive its Codex child process. */
export const leaseManagedCodexRuntime = Effect.fn("leaseManagedCodexRuntime")(function* (
  binaryPath: string,
  run: ProcessRunner["Service"]["run"],
) {
  const installation = resolveTritonAiManagedCodexInstallation(binaryPath);
  if (!installation) return;
  const path = yield* Path.Path;
  return yield* acquireManagedCodexLease(
    path.dirname(installation.installRoot),
    recoverManagedCodexUnderLock({ binaryPath, run }),
  );
});
