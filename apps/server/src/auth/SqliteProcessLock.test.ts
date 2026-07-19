// @effect-diagnostics nodeBuiltinImport:off - A real subprocess is required to verify kernel lock release after process termination.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import {
  acquireSqliteProcessLock,
  releaseSqliteProcessLock,
  SqliteProcessLockError,
  SqliteProcessLockTimeoutError,
} from "./SqliteProcessLock.ts";

const LOCK_OWNER_SCRIPT = String.raw`
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(process.argv[1]);
  database.exec("BEGIN EXCLUSIVE");
  process.stdout.write("locked\n");
  setInterval(() => {}, 1000);
`;

const LOCK_PROBE_SCRIPT = String.raw`
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(process.argv[1]);
  try {
    database.exec("BEGIN EXCLUSIVE");
    process.stdout.write("acquired");
    database.exec("ROLLBACK");
  } catch (cause) {
    if (cause && cause.errcode === 5) process.stdout.write("busy");
    else throw cause;
  } finally {
    database.close();
  }
`;

const probeLock = (lockPath: string): string =>
  NodeChildProcess.execFileSync(process.execPath, ["-e", LOCK_PROBE_SCRIPT, lockPath], {
    encoding: "utf8",
  });

const spawnLockOwner = async (lockPath: string): Promise<NodeChildProcess.ChildProcess> => {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", LOCK_OWNER_SCRIPT, lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`Lock owner exited before acquisition (code ${code}): ${stderr}`));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.once("data", (chunk: string) => {
      if (chunk.includes("locked")) resolve();
      else reject(new Error(`Unexpected lock owner output: ${chunk}`));
    });
  });
  return child;
};

const terminateLockOwner = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGKILL");
  await exited;
};

it.layer(NodeServices.layer)("SqliteProcessLock", (it) => {
  it.effect("reuses an unlocked persistent lock database", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-stale-",
      });
      const lockPath = `${directory}/secret.lock`;

      const first = yield* acquireSqliteProcessLock(lockPath, "test secret");
      yield* releaseSqliteProcessLock(first);
      assert.isTrue(yield* fileSystem.exists(lockPath));

      const second = yield* acquireSqliteProcessLock(lockPath, "test secret");
      yield* releaseSqliteProcessLock(second);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("recovers after a lock owner is forcibly terminated", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-crash-",
      });
      const lockPath = `${directory}/secret.lock`;
      const child = yield* Effect.promise(() => spawnLockOwner(lockPath));
      yield* Effect.promise(() => terminateLockOwner(child));

      const recovered = yield* acquireSqliteProcessLock(lockPath, "test secret", {
        retryCount: 4,
        retryDelay: "5 millis",
      });
      yield* releaseSqliteProcessLock(recovered);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("never steals a live owner's lock", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-live-",
      });
      const lockPath = `${directory}/secret.lock`;
      const child = yield* Effect.promise(() => spawnLockOwner(lockPath));

      yield* Effect.gen(function* () {
        const error = yield* acquireSqliteProcessLock(lockPath, "test secret", {
          retryCount: 4,
          retryDelay: "5 millis",
        }).pipe(Effect.flip);
        assert.instanceOf(error, SqliteProcessLockTimeoutError);
        assert.isNull(child.exitCode);
        assert.isNull(child.signalCode);
      }).pipe(Effect.ensuring(Effect.promise(() => terminateLockOwner(child))));
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("releases attempt resources when interrupted during a retry", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-interrupt-",
      });
      const lockPath = `${directory}/secret.lock`;
      const child = yield* Effect.promise(() => spawnLockOwner(lockPath));

      yield* Effect.gen(function* () {
        const contender = yield* acquireSqliteProcessLock(lockPath, "test secret", {
          retryCount: 100,
          retryDelay: "1 second",
        }).pipe(Effect.forkScoped);
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(contender);
      }).pipe(Effect.ensuring(Effect.promise(() => terminateLockOwner(child))));

      const recovered = yield* acquireSqliteProcessLock(lockPath, "test secret");
      yield* releaseSqliteProcessLock(recovered);
      assert.strictEqual(probeLock(lockPath), "acquired");
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("holds the kernel lock until every owned descriptor is closed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-descriptor-",
      });
      const lockPath = `${directory}/secret.lock`;

      const lock = yield* acquireSqliteProcessLock(lockPath, "test secret");
      assert.strictEqual(probeLock(lockPath), "busy");
      yield* releaseSqliteProcessLock(lock);
      assert.strictEqual(probeLock(lockPath), "acquired");
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("keeps an owner's kernel lock after a same-process contender times out", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-contender-",
      });
      const lockPath = `${directory}/secret.lock`;

      const owner = yield* acquireSqliteProcessLock(lockPath, "test secret");
      const contenderError = yield* acquireSqliteProcessLock(lockPath, "test secret", {
        retryCount: 2,
        retryDelay: "5 millis",
      }).pipe(Effect.flip);
      assert.instanceOf(contenderError, SqliteProcessLockTimeoutError);
      assert.strictEqual(probeLock(lockPath), "busy");
      yield* releaseSqliteProcessLock(owner);
      assert.strictEqual(probeLock(lockPath), "acquired");
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("cancels promptly while waiting for a same-process reservation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-local-interrupt-",
      });
      const lockPath = `${directory}/secret.lock`;

      const owner = yield* acquireSqliteProcessLock(lockPath, "test secret");
      const contender = yield* acquireSqliteProcessLock(lockPath, "test secret", {
        retryCount: 100,
        retryDelay: "1 second",
      }).pipe(Effect.forkScoped);
      yield* Effect.sleep("20 millis");
      yield* Fiber.interrupt(contender);
      assert.strictEqual(probeLock(lockPath), "busy");

      yield* releaseSqliteProcessLock(owner);
      const recovered = yield* acquireSqliteProcessLock(lockPath, "test secret");
      yield* releaseSqliteProcessLock(recovered);
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("shares a local reservation across symlinked parent aliases", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-alias-",
      });
      const actualDirectory = `${directory}/actual`;
      const aliasDirectory = `${directory}/alias`;
      const lockPath = `${actualDirectory}/secret.lock`;
      const aliasedLockPath = `${aliasDirectory}/secret.lock`;
      yield* fileSystem.makeDirectory(actualDirectory);
      yield* fileSystem.symlink(actualDirectory, aliasDirectory);

      const owner = yield* acquireSqliteProcessLock(lockPath, "test secret");
      const contenderError = yield* acquireSqliteProcessLock(aliasedLockPath, "test secret", {
        retryCount: 2,
        retryDelay: "5 millis",
      }).pipe(Effect.flip);
      assert.instanceOf(contenderError, SqliteProcessLockTimeoutError);
      assert.strictEqual(probeLock(lockPath), "busy");
      yield* releaseSqliteProcessLock(owner);
      assert.strictEqual(probeLock(aliasedLockPath), "acquired");
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("shares a local reservation with a hard-link alias created by an owner", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-hardlink-",
      });
      const lockPath = `${directory}/secret.lock`;
      const aliasPath = `${directory}/secret-alias.lock`;

      const owner = yield* acquireSqliteProcessLock(lockPath, "test secret");
      yield* fileSystem.link(lockPath, aliasPath);
      const contenderError = yield* acquireSqliteProcessLock(aliasPath, "test secret", {
        retryCount: 2,
        retryDelay: "5 millis",
      }).pipe(Effect.flip);
      assert.instanceOf(contenderError, SqliteProcessLockTimeoutError);
      assert.strictEqual(probeLock(lockPath), "busy");
      yield* releaseSqliteProcessLock(owner);
      assert.strictEqual(probeLock(lockPath), "acquired");
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("rejects a symbolic-link lock path without touching its target", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-sqlite-lock-symlink-",
      });
      const targetPath = `${directory}/target`;
      const lockPath = `${directory}/secret.lock`;
      yield* Effect.promise(() => NodeFSP.writeFile(targetPath, "unchanged", { mode: 0o644 }));
      const targetMode = (yield* Effect.promise(() => NodeFSP.stat(targetPath))).mode & 0o777;
      yield* Effect.promise(() => NodeFSP.symlink(targetPath, lockPath));

      const error = yield* acquireSqliteProcessLock(lockPath, "test secret").pipe(Effect.flip);
      assert.instanceOf(error, SqliteProcessLockError);
      assert.strictEqual(
        yield* Effect.promise(() => NodeFSP.readFile(targetPath, "utf8")),
        "unchanged",
      );
      assert.strictEqual(
        (yield* Effect.promise(() => NodeFSP.stat(targetPath))).mode & 0o777,
        targetMode,
      );
    }).pipe(Effect.scoped, TestClock.withLive),
  );
});
