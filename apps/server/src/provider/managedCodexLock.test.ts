import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import type { ProcessRunner, ProcessRunOutput } from "../processRunner.ts";
import { ManagedCodexApprovedVersion, updateTritonAiManagedCodex } from "./managedCodexUpdate.ts";
import {
  ManagedCodexLockError,
  ManagedCodexBootId,
  acquireManagedCodexLease,
  assertManagedCodexIdle,
  withManagedCodexLock,
} from "./managedCodexLock.ts";

const hooks = vi.hoisted(() => ({
  compromise: undefined as ((cause: Error) => void) | undefined,
  release: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return {
    ...actual,
    lock: async (...args: Parameters<typeof actual.lock>) => {
      const release = await actual.lock(...args);
      hooks.compromise = args[1]?.onCompromised;
      hooks.release = release;
      return release;
    },
  };
});

const success = (version = ""): ProcessRunOutput => ({
  stdout: version ? `codex-cli ${version}` : "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

// regression: #426 fix(provider): recover interrupted Codex updates and coordinate sessions
it.layer(NodeServices.layer)("managed Codex activation ownership", (it) => {
  it.effect.each(["release", "admission error"])(
    "preserves the caller's outcome when lease cleanup is locked during %s",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "codex-cleanup-test-" });
        const root = path.join(home, "codex");
        yield* fs.makeDirectory(root);
        let cleanupAttempts = 0;
        const testFs = FileSystem.FileSystem.of({
          ...fs,
          makeTempDirectory: (options) =>
            fs
              .makeTempDirectory(options)
              .pipe(
                Effect.tap(() =>
                  scenario === "admission error"
                    ? fs
                        .rename(`${root}.lock`, `${root}.retired-lock`)
                        .pipe(Effect.andThen(fs.makeDirectory(`${root}.lock`)))
                    : Effect.void,
                ),
              ),
          remove: (target, options) => {
            if (!String(target).includes(".tritonai-codex-")) return fs.remove(target, options);
            cleanupAttempts += 1;
            return Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                cause: Object.assign(new Error("directory temporarily locked"), { code: "EPERM" }),
              }),
            );
          },
        });
        const result = yield* acquireManagedCodexLease(root).pipe(
          Effect.as("session finished"),
          Effect.provideService(FileSystem.FileSystem, testFs),
          Effect.provideService(ManagedCodexBootId, Effect.succeed("old boot")),
          Effect.scoped,
          Effect.result,
        );
        if (scenario === "release") {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") expect(result.success).toBe("session finished");
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("ManagedCodexLockError");
        }
        expect(cleanupAttempts).toBe(1);
        expect((yield* fs.readDirectory(root)).length).toBe(1);
        yield* assertManagedCodexIdle(root).pipe(
          Effect.provideService(ManagedCodexBootId, Effect.succeed("new boot")),
        );
        expect(yield* fs.readDirectory(root)).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["recorded child", "unbound admission"])(
    "allows updates after partial cleanup of a closed lease with %s and unknown boot identity",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-partial-cleanup-" });
        const testFs = FileSystem.FileSystem.of({
          ...fs,
          remove: (target, options) => {
            if (!path.basename(target).startsWith(".tritonai-codex-"))
              return fs.remove(target, options);
            return fs.remove(path.join(target, "child.pid"), { force: true }).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    cause: Object.assign(new Error("directory remains locked"), { code: "EPERM" }),
                  }),
                ),
              ),
            );
          },
        });
        yield* Effect.gen(function* () {
          const lease = yield* acquireManagedCodexLease(root);
          if (scenario === "recorded child") yield* lease.bindChild(999_999_999);
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, testFs),
          Effect.provideService(ManagedCodexBootId, Effect.succeed(null)),
          Effect.scoped,
        );

        const idle = yield* withManagedCodexLock(root, assertManagedCodexIdle(root)).pipe(
          Effect.provideService(FileSystem.FileSystem, testFs),
          Effect.provideService(ManagedCodexBootId, Effect.succeed(null)),
          Effect.result,
        );
        expect(idle._tag).toBe("Success");
        expect((yield* fs.readDirectory(root)).length).toBe(1);
        yield* withManagedCodexLock(root, assertManagedCodexIdle(root));
        expect(yield* fs.readDirectory(root)).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["before registration", "after registration"])(
    "rejects lost admission ownership %s",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "codex-admission-test-" });
        const runtimeRoot = path.join(home, "codex");
        yield* fs.makeDirectory(runtimeRoot);
        const takeover = fs
          .rename(`${runtimeRoot}.lock`, `${runtimeRoot}.retired-lock`)
          .pipe(Effect.andThen(fs.makeDirectory(`${runtimeRoot}.lock`)));
        const testFs = FileSystem.FileSystem.of({
          ...fs,
          makeTempDirectory: (options) =>
            fs
              .makeTempDirectory(options)
              .pipe(Effect.tap(() => (scenario === "after registration" ? takeover : Effect.void))),
        });
        const result = yield* acquireManagedCodexLease(
          runtimeRoot,
          scenario === "before registration" ? takeover : Effect.void,
        ).pipe(Effect.provideService(FileSystem.FileSystem, testFs), Effect.scoped, Effect.exit);
        expect(result._tag).toBe("Failure");
        expect(
          (yield* fs.readDirectory(runtimeRoot)).filter((entry) =>
            entry.startsWith(".tritonai-codex-session."),
          ),
        ).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["UUID", "Windows boot sequence"])(
    "retains an incomplete PID handoff until a verified reboot (%s)",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-boot-test-" });
        const oldBoot = source === "UUID" ? "old boot" : "windows-boot:41";
        const newBoot = source === "UUID" ? "new boot" : "windows-boot:42";
        const boot = NodeCrypto.createHash("sha256").update(oldBoot).digest("hex");
        const lease = path.join(root, `.tritonai-codex-session.999999.${boot}.pending`);
        yield* fs.makeDirectory(lease);
        const deferred = yield* withManagedCodexLock(root, assertManagedCodexIdle(root)).pipe(
          Effect.provideService(ManagedCodexBootId, Effect.succeed(oldBoot)),
          Effect.exit,
        );
        expect(deferred._tag).toBe("Failure");
        expect(yield* fs.exists(lease)).toBe(true);
        yield* withManagedCodexLock(root, assertManagedCodexIdle(root)).pipe(
          Effect.provideService(ManagedCodexBootId, Effect.succeed(newBoot)),
        );
        expect(yield* fs.exists(lease)).toBe(false);
      }).pipe(Effect.scoped),
  );
  it.effect("retains a recorded live child even when the boot identity differs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-live-boot-test-" });
      const boot = NodeCrypto.createHash("sha256").update("old boot").digest("hex");
      const lease = path.join(root, `.tritonai-codex-session.999999.${boot}.recorded`);
      yield* fs.makeDirectory(lease);
      yield* fs.writeFileString(path.join(lease, "child.pid"), String(NodeProcess.pid));
      const result = yield* withManagedCodexLock(root, assertManagedCodexIdle(root)).pipe(
        Effect.provideService(ManagedCodexBootId, Effect.succeed("different boot")),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(yield* fs.exists(lease)).toBe(true);
    }).pipe(Effect.scoped),
  );
  it.effect.each(["compromised heartbeat", "replacement before heartbeat"])(
    "preserves a peer engine after %s",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "codex-lock-test-" });
        const runtimeRoot = path.join(home, ".agents", "ucsd", "runtime", "codex");
        const installRoot = path.join(runtimeRoot, "openai-codex-0.146.0");
        const binaryPath = path.join(installRoot, "bin", "codex");
        const versionFile = path.join(installRoot, "version.txt");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "managed launcher");
        yield* fs.writeFileString(versionFile, "0.146.0");
        let takeover = false;
        const run: ProcessRunner["Service"]["run"] = (input) =>
          Effect.gen(function* () {
            if (input.command === "npm") {
              const prefix = input.args[input.args.indexOf("--prefix") + 1]!;
              yield* fs.makeDirectory(path.join(prefix, "bin"), { recursive: true });
              yield* fs.writeFileString(path.join(prefix, "bin", "codex"), "generated launcher");
              yield* fs.writeFileString(path.join(prefix, "version.txt"), "0.151.0");
              return success();
            }
            const version = yield* fs.readFileString(
              path.join(path.dirname(path.dirname(input.command)), "version.txt"),
            );
            if (input.command === binaryPath && version === "0.151.0" && !takeover) {
              takeover = true;
              yield* fs.writeFileString(versionFile, "0.160.0");
              if (scenario === "compromised heartbeat") {
                hooks.compromise?.(new Error("test lease takeover"));
                return yield* Effect.never;
              }
              // Retain the original directory so inode reuse cannot make this fixture ambiguous.
              yield* fs.rename(`${runtimeRoot}.lock`, `${runtimeRoot}.retired-lock`);
              yield* fs.makeDirectory(`${runtimeRoot}.lock`);
            }
            return success(version);
          }).pipe(Effect.orDie);
        yield* updateTritonAiManagedCodex({ binaryPath, run }).pipe(
          Effect.provideService(ManagedCodexApprovedVersion, "0.151.0"),
          Effect.scoped,
          Effect.exit,
        );
        expect(takeover).toBe(true);
        expect(yield* fs.readFileString(versionFile)).toBe("0.160.0");
        const backup = (yield* fs.readDirectory(runtimeRoot)).find((entry) =>
          entry.startsWith(".tritonai-codex-backup."),
        );
        expect(backup).toBeDefined();
        expect(
          yield* fs.readFileString(
            path.join(runtimeRoot, backup!, "openai-codex-0.146.0", "version.txt"),
          ),
        ).toBe("0.146.0");
        if (scenario === "replacement before heartbeat")
          expect(yield* fs.exists(`${runtimeRoot}.lock`)).toBe(true);
        yield* Effect.tryPromise({
          try: () => hooks.release?.() ?? Promise.resolve(),
          catch: () =>
            new ManagedCodexLockError({ message: "The test lock was already released." }),
        }).pipe(Effect.ignore);
      }).pipe(Effect.scoped),
  );
});
// @effect-diagnostics nodeBuiltinImport:off - Regression fixtures identify retained leases across boots.
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
