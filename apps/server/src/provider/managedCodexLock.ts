// @effect-diagnostics nodeBuiltinImport:off - Runtime leases coordinate the server and updater processes.
import * as NodeProcess from "node:process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  Platform as HostProcessPlatform,
  Environment as HostProcessEnvironment,
} from "@t3tools/shared/HostProcess";
import { lock } from "proper-lockfile";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class ManagedCodexLockError extends Schema.TaggedError<ManagedCodexLockError>()(
  "ManagedCodexLockError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const lostOwnership = () =>
  new ManagedCodexLockError({
    message: "Codex update ownership was lost. The retained engine was preserved for recovery.",
  });

const LockOwnership = Context.Reference<Effect.Effect<void, ManagedCodexLockError>>(
  "ManagedCodexLockOwnership",
  {
    defaultValue: () => Effect.fail(lostOwnership()),
  },
);

export const assertManagedCodexLockOwnership = Effect.fn("assertManagedCodexLockOwnership")(
  function* () {
    yield* yield* LockOwnership;
  },
);

/** Only admission, recovery and activation hold this lock; package downloads never do. */
export const withManagedCodexLock = <A, E, R>(runtimeRoot: string, task: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const compromised = yield* Deferred.make<never, ManagedCodexLockError>();
      let ownershipLost = false;
      const services = yield* Effect.context<never>();
      const failure = (cause?: unknown) =>
        new ManagedCodexLockError({
          message: "The Codex runtime is busy activating an update. Try again shortly.",
          cause,
        });
      const lockPath = `${NodePath.resolve(runtimeRoot)}.lock`;
      let identity: NodeFS.BigIntStats | undefined;
      let acquired = false;
      const sameLock = (current: NodeFS.BigIntStats) =>
        identity !== undefined &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        current.birthtimeNs === identity.birthtimeNs;
      const mayRemove = (target: NodeFS.PathLike) => {
        try {
          return sameLock(NodeFS.statSync(target, { bigint: true }));
        } catch {
          return false;
        }
      };
      const guardedFs = {
        ...NodeFS,
        // proper-lockfile uses the two-argument form and retains this adapter for its exit handler.
        rmdir: (target: NodeFS.PathLike, callback: NodeFS.NoParamCallback) => {
          if (acquired && !mayRemove(target)) {
            callback(null);
            return;
          }
          NodeFS.rmdir(target, callback);
        },
        rmdirSync: (target: NodeFS.PathLike) => {
          if (mayRemove(target)) NodeFS.rmdirSync(target);
        },
      };
      const held = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const release = await lock(runtimeRoot, {
              realpath: false,
              fs: guardedFs,
              stale: 30_000,
              update: 5_000,
              retries: { retries: 320, factor: 1, minTimeout: 250, maxTimeout: 250 },
              onCompromised: (cause) => {
                ownershipLost = true;
                Effect.runSyncWith(services)(Deferred.fail(compromised, failure(cause)));
              },
            });
            acquired = true;
            try {
              identity = await NodeFSP.stat(lockPath, { bigint: true });
              return { release, identity };
            } catch (cause) {
              await release();
              throw cause;
            }
          },
          catch: failure,
        }),
        ({ release }) =>
          Effect.tryPromise({
            // Always unregister the heartbeat and exit cleanup; the fs adapter fences removal.
            try: () => release(),
            catch: failure,
          }).pipe(Effect.ignore),
      );
      const assertOwnership = Effect.try({
        try: () => {
          const current = NodeFS.statSync(lockPath, { bigint: true });
          return (
            !ownershipLost &&
            current.dev === held.identity.dev &&
            current.ino === held.identity.ino &&
            current.birthtimeNs === held.identity.birthtimeNs
          );
        },
        catch: lostOwnership,
      }).pipe(Effect.flatMap((owned) => (owned ? Effect.void : Effect.fail(lostOwnership()))));
      return yield* Effect.raceFirst(
        task.pipe(Effect.provideService(LockOwnership, assertOwnership)),
        Deferred.await(compromised),
      );
    }),
  );

const SESSION_PREFIX = ".tritonai-codex-session.";
const bootIds = new Map<NodeJS.Platform, Promise<string | null>>();
const readBootId = Effect.fn("readManagedCodexBootId")(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  let result = bootIds.get(platform);
  if (!result) {
    result =
      platform === "linux"
        ? NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")
            .then((value) => value.trim())
            .catch(() => null)
        : new Promise<string | null>((resolve) => {
            const windowsRoot =
              Object.entries(environment).find(
                ([key]) => key.toLowerCase() === "systemroot",
              )?.[1] ?? "C:\\Windows";
            const command =
              platform === "darwin"
                ? "/usr/sbin/sysctl"
                : NodePath.join(
                    windowsRoot,
                    "System32",
                    "WindowsPowerShell",
                    "v1.0",
                    "powershell.exe",
                  );
            const args =
              platform === "darwin"
                ? ["-n", "kern.bootsessionuuid"]
                : [
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
                  ];
            NodeChildProcess.execFile(
              command,
              args,
              { timeout: 5_000, maxBuffer: 1024, windowsHide: true },
              (error, stdout) => resolve(error ? null : stdout.trim() || null),
            );
          });
    bootIds.set(platform, result);
  }
  return yield* Effect.promise(() => result);
});

export const ManagedCodexBootId = Context.Reference<Effect.Effect<string | null>>(
  "ManagedCodexBootId",
  {
    defaultValue: () => readBootId(),
  },
);
const bootKey = (bootId: string | null) =>
  bootId ? NodeCrypto.createHash("sha256").update(bootId).digest("hex") : "unknown";
const pidIsAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
  }
};

/** Called under the activation lock, so a session cannot arrive between this check and the swap. */
export const assertManagedCodexIdle = Effect.fn("assertManagedCodexIdle")(function* (
  runtimeRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entry of yield* fs.readDirectory(runtimeRoot)) {
    if (!entry.startsWith(SESSION_PREFIX)) continue;
    const [, recordedBoot] = entry.slice(SESSION_PREFIX.length).split(".");
    const currentBoot = bootKey(yield* yield* ManagedCodexBootId);
    const previousBoot =
      /^[a-f0-9]{64}$/u.test(recordedBoot ?? "") &&
      currentBoot !== "unknown" &&
      recordedBoot !== currentBoot;
    const child = yield* fs
      .readFileString(path.join(runtimeRoot, entry, "child.pid"))
      .pipe(Effect.orElseSucceed(() => null));
    // A dead owner with an unfinished PID handoff remains protected until the next verified boot.
    const alive =
      !previousBoot && (child === null || (yield* Effect.sync(() => pidIsAlive(Number(child)))));
    if (alive)
      return yield* new ManagedCodexLockError({
        message: "Codex sessions are running. The update was deferred; close them and try again.",
      });
    yield* fs.remove(path.join(runtimeRoot, entry), { recursive: true, force: true });
  }
});

/** Register before spawning, and release after the session's child process finalizers. */
export const acquireManagedCodexLease = Effect.fn("acquireManagedCodexLease")(function* <
  E = never,
  R = never,
>(runtimeRoot: string, prepare?: Effect.Effect<void, E, R>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const boot = bootKey(yield* yield* ManagedCodexBootId);
  const removeLease = (directory: string) =>
    fs
      .remove(directory, { recursive: true, force: true })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove a managed Codex session lease", { cause }),
        ),
      );
  let created: string | undefined;
  const directory = yield* Effect.acquireRelease(
    withManagedCodexLock(
      runtimeRoot,
      Effect.gen(function* () {
        yield* assertManagedCodexLockOwnership();
        if (prepare) yield* prepare;
        yield* assertManagedCodexLockOwnership();
        created = yield* fs.makeTempDirectory({
          directory: runtimeRoot,
          prefix: `${SESSION_PREFIX}${NodeProcess.pid}.${boot}.`,
        });
        yield* assertManagedCodexLockOwnership();
        return created;
      }).pipe(Effect.onError(() => (created ? removeLease(created) : Effect.void))),
    ),
    // Failed cleanup keeps the lease conservative; idle checks can reap it once it is stale.
    removeLease,
  );
  return {
    bindChild: (pid: number) =>
      fs
        .writeFileString(path.join(directory, "child.pid.tmp"), String(pid))
        .pipe(
          Effect.andThen(
            fs.rename(path.join(directory, "child.pid.tmp"), path.join(directory, "child.pid")),
          ),
        ),
  };
});
