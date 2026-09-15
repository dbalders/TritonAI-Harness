// @effect-diagnostics nodeBuiltinImport:off - exercise the OS lock with an independent process.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  MANAGED_CODEX_LOCK_FILE,
  MANAGED_CODEX_JOURNAL_FILE,
  withManagedCodexLock,
  writeManagedCodexTransaction,
  recoverManagedCodexTransaction,
} from "./managedCodexTransaction.ts";

const fixture = Effect.fn("managedCodexTransaction.test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "codex-transaction-test-" });
  const transaction = {
    schemaVersion: 1 as const,
    targetName: "openai-codex-0.146.0",
    stageName: ".tritonai-codex-stage.test",
    backupName: ".tritonai-codex-backup.test",
    committed: false,
  };
  const target = path.join(root, transaction.targetName);
  const backup = path.join(root, transaction.backupName, transaction.targetName);
  yield* fs.makeDirectory(target);
  yield* fs.writeFileString(path.join(target, "version"), "old");
  yield* fs.makeDirectory(path.dirname(backup));
  yield* fs.makeDirectory(path.join(root, transaction.stageName));
  yield* writeManagedCodexTransaction(root, transaction);
  return { fs, path, root, transaction, target, backup };
});

it.layer(NodeServices.layer)("managed engine recovery", (it) => {
  for (const newEngineActivated of [false, true]) {
    it.effect(
      `recovers a process crash ${newEngineActivated ? "after" : "before"} activating the new engine`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.fs.rename(f.target, f.backup);
          if (newEngineActivated) {
            yield* f.fs.makeDirectory(f.target);
            yield* f.fs.writeFileString(f.path.join(f.target, "version"), "new-unverified");
          }
          yield* withManagedCodexLock(f.root, recoverManagedCodexTransaction(f.root));
          assert.equal(yield* f.fs.readFileString(f.path.join(f.target, "version")), "old");
          assert.isFalse(yield* f.fs.exists(f.path.join(f.root, MANAGED_CODEX_JOURNAL_FILE)));
          yield* withManagedCodexLock(f.root, recoverManagedCodexTransaction(f.root));
        }),
    );
  }

  it.effect("finishes interrupted cleanup only after the new engine was committed", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.rename(f.target, f.backup);
      yield* f.fs.makeDirectory(f.target);
      yield* f.fs.writeFileString(f.path.join(f.target, "version"), "new-verified");
      yield* writeManagedCodexTransaction(f.root, { ...f.transaction, committed: true });
      yield* withManagedCodexLock(f.root, recoverManagedCodexTransaction(f.root));
      assert.equal(yield* f.fs.readFileString(f.path.join(f.target, "version")), "new-verified");
      assert.isFalse(yield* f.fs.exists(f.backup));
    }),
  );

  it.effect("preserves recovery files if neither the target nor backup is available", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.fs.remove(f.target, { recursive: true });
      const error = yield* withManagedCodexLock(
        f.root,
        recoverManagedCodexTransaction(f.root),
      ).pipe(Effect.flip);
      assert.include(error.message, "preserved");
      assert.isTrue(yield* f.fs.exists(f.path.join(f.root, MANAGED_CODEX_JOURNAL_FILE)));
    }),
  );

  it.effect("rejects unsafe journal paths without deleting the active runtime", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* writeManagedCodexTransaction(f.root, { ...f.transaction, backupName: "../outside" });
      yield* withManagedCodexLock(f.root, recoverManagedCodexTransaction(f.root)).pipe(Effect.flip);
      assert.equal(yield* f.fs.readFileString(f.path.join(f.target, "version")), "old");
    }),
  );

  it.effect("does not run an update while another operation in this process owns the runtime", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let ran = false;
      const error = yield* withManagedCodexLock(
        f.root,
        withManagedCodexLock(
          f.root,
          Effect.sync(() => {
            ran = true;
          }),
        ).pipe(Effect.flip),
      );
      assert.include(error.message, "Another Harness app");
      assert.isFalse(ran);
    }),
  );
});

it.live(
  "coordinates with an independent updater and unlocks automatically after its process dies",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const executable = yield* HostProcessExecutablePath;
      const script = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN EXCLUSIVE'); console.log('locked'); process.stdin.resume();`;
      const child = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
              const child = NodeChildProcess.spawn(
                executable,
                ["-e", script, f.path.join(f.root, MANAGED_CODEX_LOCK_FILE)],
                { stdio: ["pipe", "pipe", "pipe"] },
              );
              child.once("error", reject);
              child.once("exit", (code) =>
                reject(new Error(`Lock owner exited before readiness: ${code}`)),
              );
              child.stdout!.once("data", () => resolve(child));
            }),
        ),
        (child) =>
          Effect.promise(async () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
            child.kill("SIGKILL");
            await exited;
          }),
      );
      const error = yield* withManagedCodexLock(f.root, Effect.succeed("should not enter")).pipe(
        Effect.flip,
      );
      assert.include(error.message, "Could not lock");
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.kill("SIGKILL");
          }),
      );
      assert.equal(yield* withManagedCodexLock(f.root, Effect.succeed("acquired")), "acquired");
    }).pipe(Effect.provide(NodeServices.layer)),
);
