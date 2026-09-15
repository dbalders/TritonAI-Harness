import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { acquireSqliteProcessLock, releaseSqliteProcessLock } from "../auth/SqliteProcessLock.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

// Shared protocol with TritonAI Installer. Never unlink the SQLite lock file.
export const MANAGED_CODEX_LOCK_FILE = ".tritonai-codex.lock.sqlite";
export const MANAGED_CODEX_JOURNAL_FILE = ".tritonai-codex-update.json";
const INSTALLER_JOURNAL_FILE = ".codex-install-transaction.json";

const Transaction = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targetName: Schema.String,
  stageName: Schema.String,
  backupName: Schema.String,
  committed: Schema.Boolean,
});
export type ManagedCodexTransaction = typeof Transaction.Type;
const decodeTransaction = Schema.decodeUnknownEffect(Schema.fromJsonString(Transaction));
const encodeTransaction = Schema.encodeSync(Schema.fromJsonString(Transaction));

export class ManagedCodexTransactionError extends Schema.TaggedErrorClass<ManagedCodexTransactionError>()(
  "ManagedCodexTransactionError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const withManagedCodexLock = <A, E, R>(
  runtimeRoot: string,
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* Effect.acquireUseRelease(
      acquireSqliteProcessLock(
        path.join(runtimeRoot, MANAGED_CODEX_LOCK_FILE),
        "the shared Codex runtime",
        {
          retryCount: 1,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ManagedCodexTransactionError({
              message:
                "Could not lock the shared Codex runtime. Another Harness app or TritonAI Installer may be updating it; retry when it finishes.",
              cause,
            }),
        ),
      ),
      () => operation,
      (lock) => releaseSqliteProcessLock(lock).pipe(Effect.orDie),
    );
  });

export const writeManagedCodexTransaction = Effect.fn("writeManagedCodexTransaction")(function* (
  runtimeRoot: string,
  transaction: ManagedCodexTransaction,
) {
  const path = yield* Path.Path;
  yield* writeFileStringAtomically({
    filePath: path.join(runtimeRoot, MANAGED_CODEX_JOURNAL_FILE),
    contents: encodeTransaction(transaction),
    mode: 0o600,
  });
});

/** Must run under the shared lock. Incomplete activation always restores the previous engine. */
export const recoverManagedCodexTransaction = Effect.fn("recoverManagedCodexTransaction")(
  function* (runtimeRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (yield* fs.exists(path.join(runtimeRoot, INSTALLER_JOURNAL_FILE))) {
      return yield* new ManagedCodexTransactionError({
        message:
          "A TritonAI Installer operation was interrupted. Run TritonAI Installer again to finish repairing Codex.",
      });
    }
    const journalPath = path.join(runtimeRoot, MANAGED_CODEX_JOURNAL_FILE);
    if (!(yield* fs.exists(journalPath))) return;
    const journal = yield* fs.readFileString(journalPath).pipe(
      Effect.flatMap(decodeTransaction),
      Effect.mapError(
        (cause) =>
          new ManagedCodexTransactionError({
            message:
              "The Codex recovery journal could not be read. The runtime and recovery files have been preserved.",
            cause,
          }),
      ),
    );
    for (const [name, pattern] of [
      [journal.targetName, /^openai-codex-[a-z0-9][a-z0-9._-]*$/u],
      [journal.stageName, /^\.tritonai-codex-stage\.[a-zA-Z0-9_-]+$/u],
      [journal.backupName, /^\.tritonai-codex-backup\.[a-zA-Z0-9_-]+$/u],
    ] as const) {
      if (!pattern.test(name) || path.basename(name) !== name) {
        return yield* new ManagedCodexTransactionError({
          message:
            "The Codex recovery journal contains an invalid path. Recovery files have been preserved.",
        });
      }
      const isLink = yield* fs.readLink(path.join(runtimeRoot, name)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (isLink)
        return yield* new ManagedCodexTransactionError({
          message:
            "A Codex recovery directory is a symbolic link. Recovery files have been preserved.",
        });
    }
    const target = path.join(runtimeRoot, journal.targetName);
    const stageRoot = path.join(runtimeRoot, journal.stageName);
    const backupRoot = path.join(runtimeRoot, journal.backupName);
    const backup = path.join(backupRoot, journal.targetName);
    if (!journal.committed && (yield* fs.exists(backup))) {
      yield* fs.remove(target, { recursive: true, force: true });
      yield* fs.rename(backup, target);
    }
    if (!(yield* fs.exists(target))) {
      return yield* new ManagedCodexTransactionError({
        message:
          "Codex recovery could not find the previous runtime. Recovery files have been preserved.",
      });
    }
    // Clearing the journal first makes leftover cleanup harmless after a successful restore/commit.
    yield* fs.remove(journalPath);
    yield* fs.remove(stageRoot, { recursive: true, force: true });
    yield* fs.remove(backupRoot, { recursive: true, force: true });
  },
);

export const cleanupFailedCodexStage = Effect.fn("cleanupFailedCodexStage")(function* (
  exit: Exit.Exit<unknown, unknown>,
  runtimeRoot: string,
  stageRoot: string,
  backupRoot: string,
) {
  if (Exit.isSuccess(exit)) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fs.exists(path.join(runtimeRoot, MANAGED_CODEX_JOURNAL_FILE))) {
    yield* recoverManagedCodexTransaction(runtimeRoot);
  } else {
    yield* fs.remove(stageRoot, { recursive: true, force: true });
    yield* fs.remove(backupRoot, { recursive: true, force: true });
  }
});
