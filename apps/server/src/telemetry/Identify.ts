/**
 * Anonymous install identity for product analytics.
 *
 * A random UUID persisted under userdata. It is not derived from the machine,
 * the person, or provider accounts, and it is separate from the environment ID
 * so it can be reset without affecting pairing or auth. Deleting the file while
 * the server is stopped resets it.
 *
 * @module Identify
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Reads or creates the install ID. Resolves to none, never a fresh ID per boot, when it cannot persist. */
export const getAnonymousInstallId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const { anonymousIdPath, stateDir } = yield* ServerConfig.ServerConfig;

  const readValid = fileSystem.readFileString(anonymousIdPath).pipe(
    Effect.map((raw) => {
      const value = raw.trim().toLowerCase();
      return UUID_PATTERN.test(value) ? Option.some(value) : Option.none<string>();
    }),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(Option.none<string>()) : Effect.fail(error),
    ),
  );

  const existing = yield* readValid;
  if (Option.isSome(existing)) return existing;

  const generated = yield* crypto.randomUUIDv4;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const tempPath = yield* fileSystem.makeTempFileScoped({
        directory: stateDir,
        prefix: ".anonymous-id-",
      });
      yield* fileSystem.writeFileString(tempPath, `${generated}\n`);
      // Publish without replacing an ID another process created first.
      const linkNoClobber = (destination: string) =>
        fileSystem.link(tempPath, destination).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            cause.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(cause),
          ),
        );
      const linked = yield* linkNoClobber(anonymousIdPath);
      if (!linked && Option.isNone(yield* readValid)) {
        // An invalid file is in the way. Racing processes agree on one replacement through
        // a no-clobber recovery file, then each publishes that same winner.
        const recoveryPath = `${anonymousIdPath}.recovery`;
        yield* linkNoClobber(recoveryPath);
        yield* fileSystem.remove(tempPath);
        yield* fileSystem.copyFile(recoveryPath, tempPath);
        yield* fileSystem.rename(tempPath, anonymousIdPath);
      }
    }),
  );
  return yield* readValid;
}).pipe(
  Effect.tapError((cause) =>
    Effect.logWarning("analytics install ID unavailable; sending events without it", { cause }),
  ),
  Effect.orElseSucceed(() => Option.none<string>()),
);
