// @effect-diagnostics nodeBuiltinImport:off - O_NOFOLLOW and descriptor identity checks are required to keep SQLite lock paths race-safe.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const DEFAULT_RETRY_COUNT = 200;
const DEFAULT_RETRY_DELAY = "25 millis";

export class SqliteProcessLockError extends Schema.TaggedErrorClass<SqliteProcessLockError>()(
  "SqliteProcessLockError",
  {
    resource: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to operate the process lock for ${this.resource}.`;
  }
}

export class SqliteProcessLockTimeoutError extends Schema.TaggedErrorClass<SqliteProcessLockTimeoutError>()(
  "SqliteProcessLockTimeoutError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Timed out waiting to lock ${this.resource}.`;
  }
}

export interface SqliteProcessLock {
  readonly database: NodeSqlite.DatabaseSync;
  readonly localReservationId: symbol;
  readonly resource: string;
  readonly validationFd: number;
}

export interface SqliteProcessLockOptions {
  readonly retryCount?: number;
  readonly retryDelay?: Parameters<typeof Effect.sleep>[0];
}

const isSqliteBusy = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "errcode" in cause && cause.errcode === 5;

interface LocalReservationState {
  readonly deferredFds: Array<number>;
  readonly id: symbol;
  readonly keys: Set<string>;
}

const localReservationsByKey = new Map<string, LocalReservationState>();
const localReservationsById = new Map<symbol, LocalReservationState>();

const tryAcquireLocalReservation = (
  keys: ReadonlyArray<string>,
  resource: string,
): Effect.Effect<symbol | null> =>
  Effect.sync(() => {
    if (keys.some((key) => localReservationsByKey.has(key))) return null;
    const state: LocalReservationState = {
      deferredFds: [],
      id: Symbol(resource),
      keys: new Set(keys),
    };
    localReservationsById.set(state.id, state);
    for (const key of state.keys) localReservationsByKey.set(key, state);
    return state.id;
  });

const releaseLocalReservation = (id: symbol): Effect.Effect<void> =>
  Effect.sync(() => {
    const state = localReservationsById.get(id);
    if (!state) return;
    for (const key of state.keys) {
      if (localReservationsByKey.get(key) === state) localReservationsByKey.delete(key);
    }
    localReservationsById.delete(id);
    for (const fd of state.deferredFds) {
      try {
        NodeFS.closeSync(fd);
      } catch {
        // The owning SQLite transaction is already closed, so a leaked
        // validation descriptor cannot compromise lock exclusivity.
      }
    }
  });

const closeDatabase = (database: NodeSqlite.DatabaseSync, resource: string) =>
  Effect.try({
    try: () => database.close(),
    catch: (cause) => new SqliteProcessLockError({ resource, cause }),
  });

interface ValidatedLockPath {
  readonly fd: number;
  readonly identity: NodeFS.Stats;
}

const isMissingPathError = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const inspectLockPath = (lockPath: string): NodeFS.Stats | null => {
  try {
    return NodeFS.lstatSync(lockPath);
  } catch (cause) {
    if (isMissingPathError(cause)) return null;
    throw cause;
  }
};

const canonicalizeLocalReservationKeys = (
  lockPath: string,
  resource: string,
  hostPlatform: NodeJS.Platform,
): Effect.Effect<ReadonlyArray<string>, SqliteProcessLockError> =>
  Effect.try({
    try: () => {
      const absolutePath = NodePath.resolve(lockPath);
      const existing = inspectLockPath(absolutePath);
      if (existing?.isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed for SQLite process lock files.");
      }
      const canonicalParent = NodeFS.realpathSync.native(NodePath.dirname(absolutePath));
      const canonicalPath = NodePath.join(canonicalParent, NodePath.basename(absolutePath));
      const normalized = canonicalPath.normalize("NFC");
      const pathKey = `path:${
        hostPlatform === "darwin" || hostPlatform === "win32"
          ? normalized.toLocaleLowerCase("en-US")
          : normalized
      }`;
      return existing === null ? [pathKey] : [pathKey, `inode:${existing.dev}:${existing.ino}`];
    },
    catch: (cause) => new SqliteProcessLockError({ resource, cause }),
  });

const claimLocalIdentity = (reservationId: symbol, identity: NodeFS.Stats, fd: number): boolean => {
  const state = localReservationsById.get(reservationId);
  if (!state) throw new Error("The local SQLite reservation disappeared during acquisition.");
  const identityKey = `inode:${identity.dev}:${identity.ino}`;
  const owner = localReservationsByKey.get(identityKey);
  if (owner && owner !== state) {
    owner.deferredFds.push(fd);
    return false;
  }
  state.keys.add(identityKey);
  localReservationsByKey.set(identityKey, state);
  return true;
};

const sameFile = (left: NodeFS.Stats, right: NodeFS.Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertSafeLockPath = (
  lockPath: string,
  opened: NodeFS.Stats,
  beforeOpen: NodeFS.Stats | null,
): void => {
  const afterOpen = NodeFS.lstatSync(lockPath);
  if (
    !opened.isFile() ||
    opened.nlink !== 1 ||
    afterOpen.isSymbolicLink() ||
    !afterOpen.isFile() ||
    afterOpen.nlink !== 1 ||
    !sameFile(opened, afterOpen) ||
    (beforeOpen !== null && !sameFile(beforeOpen, opened))
  ) {
    throw new Error("The SQLite process lock path must remain one regular file while opening.");
  }
};

const openValidatedLockPath = (
  lockPath: string,
  resource: string,
  hostPlatform: NodeJS.Platform,
  reservationId: symbol,
): Effect.Effect<ValidatedLockPath, SqliteProcessLockError> =>
  Effect.try({
    try: () => {
      const beforeOpen = inspectLockPath(lockPath);
      if (beforeOpen?.isSymbolicLink()) {
        throw new Error("Symbolic links are not allowed for SQLite process lock files.");
      }
      const noFollowFlag = hostPlatform === "win32" ? 0 : NodeFS.constants.O_NOFOLLOW;
      let fd: number | undefined;
      let descriptorTransferred = false;
      try {
        fd = NodeFS.openSync(
          lockPath,
          NodeFS.constants.O_CREAT | NodeFS.constants.O_RDWR | noFollowFlag,
          0o600,
        );
        const identity = NodeFS.fstatSync(fd);
        if (!claimLocalIdentity(reservationId, identity, fd)) {
          descriptorTransferred = true;
          throw new Error("The SQLite lock inode is already reserved by this process.");
        }
        assertSafeLockPath(lockPath, identity, beforeOpen);
        NodeFS.fchmodSync(fd, 0o600);
        return { fd, identity };
      } catch (cause) {
        if (fd !== undefined && !descriptorTransferred) NodeFS.closeSync(fd);
        throw cause;
      }
    },
    catch: (cause) => new SqliteProcessLockError({ resource, cause }),
  });

const closeValidatedLockPath = (fd: number, resource: string) =>
  Effect.try({
    try: () => NodeFS.closeSync(fd),
    catch: (cause) => new SqliteProcessLockError({ resource, cause }),
  });

const openDatabaseForValidatedPath = (
  lockPath: string,
  resource: string,
  identity: NodeFS.Stats,
): Effect.Effect<NodeSqlite.DatabaseSync, SqliteProcessLockError> =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(lockPath);
      try {
        assertSafeLockPath(lockPath, identity, identity);
        return database;
      } catch (cause) {
        database.close();
        throw cause;
      }
    },
    catch: (cause) => new SqliteProcessLockError({ resource, cause }),
  });

/**
 * Holds an OS-managed SQLite exclusive transaction for the lock lifetime.
 * The database file intentionally persists, while the kernel lock is released
 * automatically if the owning process exits or crashes.
 */
export const acquireSqliteProcessLock = (
  lockPath: string,
  resource: string,
  options: SqliteProcessLockOptions = {},
): Effect.Effect<SqliteProcessLock, SqliteProcessLockError | SqliteProcessLockTimeoutError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      const retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
      const retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY;
      const reservationKeys = yield* canonicalizeLocalReservationKeys(
        lockPath,
        resource,
        hostPlatform,
      );
      let localReservationId: symbol | null = null;
      for (let attempt = 0; attempt < retryCount; attempt += 1) {
        localReservationId = yield* tryAcquireLocalReservation(reservationKeys, resource);
        if (localReservationId !== null) break;
        if (attempt + 1 < retryCount) yield* restore(Effect.sleep(retryDelay));
      }
      if (localReservationId === null) {
        return yield* new SqliteProcessLockTimeoutError({ resource });
      }

      const acquiredLocalReservationId = localReservationId;
      let retainLocalReservation = false;
      let retainValidationDescriptor = false;
      return yield* Effect.acquireUseRelease(
        openValidatedLockPath(lockPath, resource, hostPlatform, acquiredLocalReservationId),
        ({ fd, identity }) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < retryCount; attempt += 1) {
              let retainDatabase = false;
              const acquisition = yield* Effect.acquireUseRelease(
                openDatabaseForValidatedPath(lockPath, resource, identity),
                (database) =>
                  Effect.sync(() => {
                    try {
                      database.exec("BEGIN EXCLUSIVE");
                      retainDatabase = true;
                      retainValidationDescriptor = true;
                      retainLocalReservation = true;
                      return {
                        _tag: "Acquired",
                        lock: {
                          database,
                          localReservationId: acquiredLocalReservationId,
                          resource,
                          validationFd: fd,
                        },
                      } as const;
                    } catch (cause) {
                      return { _tag: "Failed", cause } as const;
                    }
                  }),
                (database) =>
                  retainDatabase
                    ? Effect.void
                    : closeDatabase(database, resource).pipe(Effect.orDie),
              );
              if (acquisition._tag === "Acquired") return acquisition.lock;

              if (!isSqliteBusy(acquisition.cause)) {
                return yield* new SqliteProcessLockError({
                  resource,
                  cause: acquisition.cause,
                });
              }

              if (attempt + 1 < retryCount) {
                yield* restore(Effect.sleep(retryDelay));
              }
            }

            return yield* new SqliteProcessLockTimeoutError({ resource });
          }),
        ({ fd }) =>
          retainValidationDescriptor
            ? Effect.void
            : closeValidatedLockPath(fd, resource).pipe(Effect.orDie),
      ).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            retainLocalReservation
              ? Effect.void
              : releaseLocalReservation(acquiredLocalReservationId),
          ),
        ),
      );
    }),
  );

export const releaseSqliteProcessLock = (
  lock: SqliteProcessLock,
): Effect.Effect<void, SqliteProcessLockError> =>
  Effect.gen(function* () {
    const rollbackResult = yield* Effect.result(
      Effect.try({
        try: () => lock.database.exec("ROLLBACK"),
        catch: (cause) => new SqliteProcessLockError({ resource: lock.resource, cause }),
      }),
    );
    const closeResult = yield* Effect.result(closeDatabase(lock.database, lock.resource));
    const validationCloseResult = yield* Effect.result(
      closeValidatedLockPath(lock.validationFd, lock.resource),
    );
    const failures = [rollbackResult, closeResult, validationCloseResult].flatMap((result) =>
      result._tag === "Failure" ? [result.failure] : [],
    );
    if (failures.length === 0) return;
    return yield* new SqliteProcessLockError({
      resource: lock.resource,
      cause:
        failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "One or more process lock resources failed to close."),
    });
  }).pipe(Effect.ensuring(releaseLocalReservation(lock.localReservationId)));
