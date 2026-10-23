// @effect-diagnostics nodeBuiltinImport:off - Runtime leases coordinate the server and updater processes.
import * as NodeProcess from "node:process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
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
      const held = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const release = await lock(runtimeRoot, {
              realpath: false,
              stale: 30_000,
              update: 5_000,
              retries: { retries: 320, factor: 1, minTimeout: 250, maxTimeout: 250 },
              onCompromised: (cause) => {
                ownershipLost = true;
                Effect.runSyncWith(services)(Deferred.fail(compromised, failure(cause)));
              },
            });
            try {
              return { release, identity: await NodeFSP.stat(lockPath, { bigint: true }) };
            } catch (cause) {
              await release();
              throw cause;
            }
          },
          catch: failure,
        }),
        ({ release, identity }) =>
          Effect.tryPromise({
            try: async () => {
              const current = await NodeFSP.stat(lockPath, { bigint: true });
              // Never remove another process's replacement lock, even before the heartbeat notices.
              if (current.dev === identity.dev && current.ino === identity.ino) await release();
            },
            catch: failure,
          }).pipe(Effect.ignore),
      );
      const assertOwnership = Effect.tryPromise({
        try: async () => {
          const current = await NodeFSP.stat(lockPath, { bigint: true });
          return (
            !ownershipLost && current.dev === held.identity.dev && current.ino === held.identity.ino
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

/** Called under the activation lock, so a session cannot arrive between this check and the swap. */
export const assertManagedCodexIdle = Effect.fn("assertManagedCodexIdle")(function* (
  runtimeRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const entry of yield* fs.readDirectory(runtimeRoot)) {
    if (!entry.startsWith(SESSION_PREFIX)) continue;
    const pid = Number(entry.slice(SESSION_PREFIX.length).split(".")[0]);
    // Unrecognized leases are retained; uncertainty must never permit an activation.
    const alive =
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      (yield* Effect.sync(() => {
        try {
          NodeProcess.kill(pid, 0);
          return true;
        } catch (cause) {
          return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
        }
      }));
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
  yield* Effect.acquireRelease(
    withManagedCodexLock(
      runtimeRoot,
      (prepare ?? Effect.void).pipe(
        Effect.andThen(
          fs.makeTempDirectory({
            directory: runtimeRoot,
            prefix: `${SESSION_PREFIX}${NodeProcess.pid}.`,
          }),
        ),
      ),
    ),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
});
