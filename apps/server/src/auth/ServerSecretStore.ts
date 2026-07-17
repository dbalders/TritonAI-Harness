import * as NodeCrypto from "node:crypto";

import * as SecretEnvelope from "@t3tools/shared/secretEnvelope";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const DATA_KEY_BYTES = 32;
const EXTERNAL_KEYRING_LOCK_RETRY_COUNT = 200;
const EXTERNAL_KEYRING_LOCK_RETRY_DELAY = "25 millis";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedErrorClass<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedErrorClass<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedErrorClass<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedErrorClass<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedErrorClass<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedErrorClass<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedErrorClass<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedErrorClass<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedErrorClass<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export class SecretStoreKeyError extends Schema.TaggedErrorClass<SecretStoreKeyError>()(
  "SecretStoreKeyError",
  {
    resource: Schema.String,
    reason: Schema.Literals([
      "missing-provider",
      "invalid-key-encoding",
      "invalid-key-length",
      "invalid-fingerprint-encoding",
      "invalid-fingerprint-length",
      "missing-migration-keyring",
    ]),
  },
) {
  override get message(): string {
    return `Failed to unlock ${this.resource}.`;
  }
}

export class SecretStoreLockError extends Schema.TaggedErrorClass<SecretStoreLockError>()(
  "SecretStoreLockError",
  {
    resource: Schema.String,
    reason: Schema.Literals(["timeout", "ownership-changed"]),
  },
) {
  override get message(): string {
    return this.reason === "timeout"
      ? `Timed out waiting to lock ${this.resource}.`
      : `Lost ownership of the lock for ${this.resource}.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
  SecretStoreKeyError,
  SecretStoreLockError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

const isAlreadyExistsPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  isPlatformError(value) && value.reason._tag === "AlreadyExists";

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isAlreadyExistsPlatformError(error.cause);

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore") {}

const decodeConfiguredKeys = Effect.fn("ServerSecretStore.decodeConfiguredKeys")(function* (
  encodedKeys: ReadonlyArray<string> | undefined,
) {
  if (encodedKeys === undefined || encodedKeys.length === 0) {
    return yield* new SecretStoreKeyError({
      resource: "server secret encryption key",
      reason: "missing-provider",
    });
  }

  const keys: Buffer[] = [];
  for (const encoded of encodedKeys) {
    const decoded = yield* Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
      Effect.mapError(
        () =>
          new SecretStoreKeyError({
            resource: "server secret encryption key",
            reason: "invalid-key-encoding",
          }),
      ),
    );
    if (decoded.byteLength !== DATA_KEY_BYTES) {
      return yield* new SecretStoreKeyError({
        resource: "server secret encryption key",
        reason: "invalid-key-length",
      });
    }
    keys.push(Buffer.from(decoded));
  }
  return [keys[0]!, ...keys.slice(1)] as const;
});

const decodeLegacyFingerprints = Effect.fn("ServerSecretStore.decodeLegacyFingerprints")(function* (
  configured: Readonly<Record<string, string>> | undefined,
) {
  const fingerprints = new Map<string, Buffer>();
  for (const [name, encoded] of Object.entries(configured ?? {})) {
    const decoded = yield* Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
      Effect.mapError(
        () =>
          new SecretStoreKeyError({
            resource: "legacy secret migration fingerprint",
            reason: "invalid-fingerprint-encoding",
          }),
      ),
    );
    if (decoded.byteLength !== 32) {
      return yield* new SecretStoreKeyError({
        resource: "legacy secret migration fingerprint",
        reason: "invalid-fingerprint-length",
      });
    }
    fingerprints.set(name, Buffer.from(decoded));
  }
  return fingerprints;
});

const ExternalSecretStoreKeyring = Schema.Struct({
  version: Schema.Literal(1),
  active: Schema.String,
  previous: Schema.optionalKey(Schema.Array(Schema.String)),
  legacySecretFingerprints: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const decodeExternalSecretStoreKeyring = Schema.decodeEffect(
  Schema.fromJsonString(ExternalSecretStoreKeyring),
);
const encodeExternalSecretStoreKeyring = Schema.encodeEffect(
  Schema.fromJsonString(ExternalSecretStoreKeyring),
);

const isTrustedLegacyValue = (
  name: string,
  value: Uint8Array,
  keys: readonly [Buffer, ...Buffer[]],
  fingerprints: ReadonlyMap<string, Buffer>,
): boolean => {
  const expected = fingerprints.get(name);
  if (expected === undefined) return false;
  return keys.some((key) =>
    NodeCrypto.timingSafeEqual(
      Buffer.from(SecretEnvelope.fingerprintLegacyServerSecret(name, value, key)),
      expected,
    ),
  );
};

const encodeEnvelope = (
  name: string,
  value: Uint8Array,
  key: Buffer,
): Effect.Effect<Uint8Array, SecretStoreEncodeError> =>
  Effect.try({
    try: () => SecretEnvelope.encodeServerSecretEnvelope(name, value, key),
    catch: (cause) =>
      new SecretStoreEncodeError({
        resource: `secret ${name}`,
        cause,
      }),
  });

const decodeEnvelope = (
  name: string,
  envelope: Uint8Array,
  keys: readonly [Buffer, ...Buffer[]],
): Effect.Effect<SecretEnvelope.DecodedServerSecretEnvelope, SecretStoreDecodeError> =>
  Effect.try({
    try: () => SecretEnvelope.decodeServerSecretEnvelope(name, envelope, keys),
    catch: (cause) =>
      new SecretStoreDecodeError({
        resource: `secret ${name}`,
        cause,
      }),
  });

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const keys = yield* decodeConfiguredKeys(serverConfig.secretStoreKeys);
  const legacyFingerprints = yield* decodeLegacyFingerprints(serverConfig.legacySecretFingerprints);
  if (
    legacyFingerprints.size > 0 &&
    serverConfig.secretStoreKeyFilePath === undefined &&
    serverConfig.mode !== "desktop"
  ) {
    return yield* new SecretStoreKeyError({
      resource: "legacy secret migration authorization",
      reason: "missing-migration-keyring",
    });
  }
  const mutex = yield* Semaphore.make(1);

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${serverConfig.secretsDir}`,
          cause,
        }),
    ),
  );

  const resolveSecretPath = (name: string) => path.join(serverConfig.secretsDir, `${name}.bin`);
  const syncDirectory = (directoryPath: string) =>
    hostPlatform === "win32"
      ? Effect.void
      : Effect.scoped(
          fileSystem.open(directoryPath, { flag: "r" }).pipe(Effect.flatMap((file) => file.sync)),
        );

  interface ExternalKeyringLock {
    readonly lockPath: string;
    readonly owner: string;
  }

  const acquireExternalKeyringLock = (
    keyFilePath: string,
  ): Effect.Effect<
    ExternalKeyringLock,
    PlatformError.PlatformError | SecretStoreLockError | SecretStoreTemporaryPathError
  > =>
    Effect.gen(function* () {
      const lockPath = `${keyFilePath}.lock`;
      const owner = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new SecretStoreTemporaryPathError({
              resource: "external secret-store keyring lock",
              cause,
            }),
        ),
      );

      for (let attempt = 0; attempt < EXTERNAL_KEYRING_LOCK_RETRY_COUNT; attempt += 1) {
        let created = false;
        const acquired = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(lockPath, { flag: "wx", mode: 0o600 });
            created = true;
            yield* file.writeAll(new TextEncoder().encode(owner));
            yield* file.sync;
          }),
        ).pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            isAlreadyExistsPlatformError(cause)
              ? Effect.succeed(false)
              : created
                ? fileSystem
                    .remove(lockPath, { force: true })
                    .pipe(Effect.andThen(Effect.fail(cause)))
                : Effect.fail(cause),
          ),
        );
        if (acquired) return { lockPath, owner } as const;
        yield* Effect.sleep(EXTERNAL_KEYRING_LOCK_RETRY_DELAY);
      }

      return yield* new SecretStoreLockError({
        resource: "external secret-store keyring",
        reason: "timeout",
      });
    });

  const releaseExternalKeyringLock = (
    lock: ExternalKeyringLock,
  ): Effect.Effect<void, PlatformError.PlatformError | SecretStoreLockError> =>
    Effect.gen(function* () {
      const currentOwner = yield* fileSystem.readFileString(lock.lockPath).pipe(
        Effect.mapError((cause): PlatformError.PlatformError | SecretStoreLockError => {
          if (cause.reason._tag === "NotFound") {
            return new SecretStoreLockError({
              resource: "external secret-store keyring",
              reason: "ownership-changed",
            });
          }
          return cause;
        }),
      );
      if (currentOwner !== lock.owner) {
        return yield* new SecretStoreLockError({
          resource: "external secret-store keyring",
          reason: "ownership-changed",
        });
      }
      yield* fileSystem.remove(lock.lockPath);
    });

  const retireLegacyAuthorization = (name: string): Effect.Effect<void, SecretStoreError> => {
    const expected = legacyFingerprints.get(name);
    if (expected === undefined) return Effect.void;

    return Effect.gen(function* () {
      const keyFilePath = serverConfig.secretStoreKeyFilePath;
      if (keyFilePath !== undefined) {
        yield* Effect.acquireUseRelease(
          acquireExternalKeyringLock(keyFilePath),
          () =>
            Effect.gen(function* () {
              const raw = yield* fileSystem.readFileString(keyFilePath);
              const keyring = yield* decodeExternalSecretStoreKeyring(raw).pipe(
                Effect.mapError(
                  () =>
                    new SecretStorePersistError({
                      resource: "legacy migration authorization",
                      cause: new Error("The external secret-store keyring is invalid."),
                    }),
                ),
              );
              const currentFingerprint = keyring.legacySecretFingerprints?.[name];
              if (currentFingerprint === undefined) {
                // Another process can migrate the same authorized bytes and
                // durably retire the fingerprint while this process waits for
                // the lock. The absent entry is already the required final
                // state; a different entry remains a hard failure below.
                return;
              }
              if (currentFingerprint !== Encoding.encodeBase64(expected)) {
                return yield* new SecretStorePersistError({
                  resource: `legacy migration authorization for secret ${name}`,
                  cause: new Error("The external secret-store keyring changed during migration."),
                });
              }

              const remaining = { ...keyring.legacySecretFingerprints };
              delete remaining[name];
              const updated = `${yield* encodeExternalSecretStoreKeyring({
                version: 1,
                active: keyring.active,
                ...(keyring.previous === undefined ? {} : { previous: keyring.previous }),
                legacySecretFingerprints: remaining,
              }).pipe(
                Effect.mapError(
                  () =>
                    new SecretStorePersistError({
                      resource: "legacy migration authorization",
                      cause: new Error("External keyring encoding failed."),
                    }),
                ),
              )}\n`;
              const uuid = yield* crypto.randomUUIDv4.pipe(
                Effect.mapError(
                  (cause) =>
                    new SecretStoreTemporaryPathError({
                      resource: "external secret-store keyring",
                      cause,
                    }),
                ),
              );
              const tempPath = `${keyFilePath}.${uuid}.tmp`;
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
                  yield* file.writeAll(new TextEncoder().encode(updated));
                  yield* fileSystem.chmod(tempPath, 0o600);
                  yield* file.sync;
                  const verifiedRaw = yield* fileSystem.readFileString(tempPath);
                  const verified = yield* decodeExternalSecretStoreKeyring(verifiedRaw).pipe(
                    Effect.mapError(
                      () =>
                        new SecretStorePersistError({
                          resource: "legacy migration authorization",
                          cause: new Error("External keyring verification failed."),
                        }),
                    ),
                  );
                  const verifiedPrevious = verified.previous ?? [];
                  const expectedPrevious = keyring.previous ?? [];
                  if (
                    verified.active !== keyring.active ||
                    verifiedPrevious.length !== expectedPrevious.length ||
                    verifiedPrevious.some((key, index) => key !== expectedPrevious[index]) ||
                    Object.keys(verified.legacySecretFingerprints ?? {}).length !==
                      Object.keys(remaining).length ||
                    Object.entries(remaining).some(
                      ([secretName, fingerprint]) =>
                        verified.legacySecretFingerprints?.[secretName] !== fingerprint,
                    ) ||
                    verified.legacySecretFingerprints?.[name] !== undefined
                  ) {
                    return yield* new SecretStorePersistError({
                      resource: "legacy migration authorization",
                      cause: new Error("External keyring verification failed."),
                    });
                  }
                  yield* fileSystem.rename(tempPath, keyFilePath);
                  yield* fileSystem.chmod(keyFilePath, 0o600);
                  yield* syncDirectory(path.dirname(keyFilePath));
                }),
              ).pipe(
                Effect.catch((operationCause) =>
                  fileSystem.remove(tempPath, { force: true }).pipe(
                    Effect.andThen(syncDirectory(path.dirname(tempPath))),
                    Effect.matchEffect({
                      onFailure: (cleanupCause) =>
                        Effect.fail(
                          new SecretStorePersistError({
                            resource: "external secret-store keyring temporary file cleanup",
                            cause: new AggregateError(
                              [operationCause, cleanupCause],
                              "The keyring update failed and its raw-key temporary file could not be removed durably.",
                            ),
                          }),
                        ),
                      onSuccess: () => Effect.fail(operationCause),
                    }),
                  ),
                ),
              );
            }),
          releaseExternalKeyringLock,
        );
      }
      legacyFingerprints.delete(name);
    }).pipe(
      Effect.mapError((cause) =>
        isSecretStoreError(cause)
          ? cause
          : new SecretStorePersistError({
              resource: `legacy migration authorization for secret ${name}`,
              cause,
            }),
      ),
    );
  };

  const persistReplacing = (name: string, value: Uint8Array) => {
    const secretPath = resolveSecretPath(name);
    return Effect.gen(function* () {
      const envelope = yield* encodeEnvelope(name, value, keys[0]);
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new SecretStoreTemporaryPathError({
              resource: `secret ${name}`,
              cause,
            }),
        ),
      );
      const tempPath = `${secretPath}.${uuid}.tmp`;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(envelope);
          yield* fileSystem.chmod(tempPath, 0o600);
          yield* file.sync;

          const persisted = yield* fileSystem.readFile(tempPath);
          const verified = yield* decodeEnvelope(name, persisted, keys);
          if (
            verified.keyIndex !== 0 ||
            verified.value.byteLength !== value.byteLength ||
            !NodeCrypto.timingSafeEqual(Buffer.from(verified.value), Buffer.from(value))
          ) {
            return yield* new SecretStorePersistError({
              resource: `secret ${name}`,
              cause: new Error("Encrypted secret verification failed."),
            });
          }

          yield* fileSystem.rename(tempPath, secretPath);
          yield* fileSystem.chmod(secretPath, 0o600);
          yield* syncDirectory(serverConfig.secretsDir);
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isSecretStoreError(cause)
            ? cause
            : new SecretStorePersistError({ resource: `secret ${name}`, cause }),
        ),
        Effect.catch((cause) =>
          fileSystem.remove(tempPath).pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
        ),
      );
    });
  };

  const getUnlocked: ServerSecretStore["Service"]["get"] = (name) =>
    Effect.gen(function* () {
      const storedOption: Option.Option<Uint8Array> = yield* fileSystem
        .readFile(resolveSecretPath(name))
        .pipe(
          Effect.map((bytes): Option.Option<Uint8Array> => Option.some(Uint8Array.from(bytes))),
          Effect.mapError(
            (cause) =>
              new SecretStoreReadError({
                resource: `secret ${name}`,
                cause,
              }),
          ),
          Effect.catch((error) =>
            isPlatformError(error.cause) && error.cause.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<Uint8Array>())
              : Effect.fail(error),
          ),
        );
      if (Option.isNone(storedOption)) {
        yield* retireLegacyAuthorization(name);
        return Option.none<Uint8Array>();
      }

      const stored = storedOption.value;
      if (isTrustedLegacyValue(name, stored, keys, legacyFingerprints)) {
        // Only bytes fingerprinted while the OS-protected data key was first
        // created are eligible for migration. This prevents damaged envelope
        // headers from being reclassified as unauthenticated plaintext.
        yield* persistReplacing(name, stored);
        yield* retireLegacyAuthorization(name);
        return Option.some(Uint8Array.from(stored));
      }

      const decoded = yield* decodeEnvelope(name, stored, keys);
      if (decoded.keyIndex !== 0) {
        yield* persistReplacing(name, decoded.value);
      }
      yield* retireLegacyAuthorization(name);
      return Option.some(decoded.value);
    });

  const get: ServerSecretStore["Service"]["get"] = (name) =>
    mutex.withPermits(1)(getUnlocked(name)).pipe(Effect.withSpan("ServerSecretStore.get"));

  const set: ServerSecretStore["Service"]["set"] = (name, value) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          yield* persistReplacing(name, Uint8Array.from(value));
          yield* retireLegacyAuthorization(name);
        }),
      )
      .pipe(Effect.withSpan("ServerSecretStore.set"));

  const createUnlocked: ServerSecretStore["Service"]["create"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    return Effect.gen(function* () {
      const envelope = yield* encodeEnvelope(name, value, keys[0]);
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new SecretStoreTemporaryPathError({
              resource: `secret ${name}`,
              cause,
            }),
        ),
      );
      const tempPath = `${secretPath}.${uuid}.tmp`;

      yield* Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
            yield* file.writeAll(envelope);
            yield* fileSystem.chmod(tempPath, 0o600);
            yield* file.sync;
          }),
        );

        const persisted = yield* fileSystem.readFile(tempPath);
        const verified = yield* decodeEnvelope(name, persisted, keys);
        if (
          verified.keyIndex !== 0 ||
          verified.value.byteLength !== value.byteLength ||
          !NodeCrypto.timingSafeEqual(Buffer.from(verified.value), Buffer.from(value))
        ) {
          return yield* new SecretStorePersistError({
            resource: `secret ${name}`,
            cause: new Error("Encrypted secret verification failed."),
          });
        }

        // Hard-linking publishes the verified inode only if the canonical path
        // is still absent. Cleanup owns only tempPath, so it can never delete a
        // value concurrently published by another store instance.
        yield* fileSystem.link(tempPath, secretPath);
        yield* syncDirectory(serverConfig.secretsDir);
      }).pipe(
        Effect.mapError((cause) =>
          isSecretStoreError(cause)
            ? cause
            : new SecretStorePersistError({ resource: `secret ${name}`, cause }),
        ),
        Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
      );
    });
  };

  const create: ServerSecretStore["Service"]["create"] = (name, value) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* createUnlocked(name, Uint8Array.from(value));
        yield* retireLegacyAuthorization(name);
      }),
    );

  const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
    mutex
      .withPermits(1)(
        getUnlocked(name).pipe(
          Effect.flatMap(
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                crypto.randomBytes(bytes).pipe(
                  Effect.mapError(
                    (cause) =>
                      new SecretStoreRandomGenerationError({
                        resource: `secret ${name}`,
                        cause,
                      }),
                  ),
                  Effect.flatMap((generated) =>
                    Effect.gen(function* () {
                      yield* createUnlocked(name, generated);
                      yield* retireLegacyAuthorization(name);
                      return Uint8Array.from(generated);
                    }).pipe(
                      Effect.catchIf(isSecretStoreError, (error) =>
                        isSecretAlreadyExistsError(error)
                          ? getUnlocked(name).pipe(
                              Effect.flatMap(
                                Option.match({
                                  onSome: Effect.succeed,
                                  onNone: () =>
                                    Effect.fail(
                                      new SecretStoreConcurrentReadError({
                                        resource: `secret ${name}`,
                                      }),
                                    ),
                                }),
                              ),
                            )
                          : Effect.fail(error),
                      ),
                    ),
                  ),
                ),
            }),
          ),
        ),
      )
      .pipe(Effect.withSpan("ServerSecretStore.getOrCreateRandom"));

  const removeUnlocked: ServerSecretStore["Service"]["remove"] = (name) => {
    const secretPath = resolveSecretPath(name);
    const tempPrefix = `${path.basename(secretPath)}.`;
    return Effect.gen(function* () {
      yield* fileSystem
        .remove(secretPath)
        .pipe(
          Effect.catch((cause) =>
            cause.reason._tag === "NotFound" ? Effect.void : Effect.fail(cause),
          ),
        );
      const entries = yield* fileSystem.readDirectory(serverConfig.secretsDir);
      yield* Effect.forEach(
        entries.filter((entry) => entry.startsWith(tempPrefix) && entry.endsWith(".tmp")),
        (entry) => fileSystem.remove(path.join(serverConfig.secretsDir, entry)),
        { discard: true },
      );
      yield* syncDirectory(serverConfig.secretsDir);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreRemoveError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
    );
  };

  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          yield* removeUnlocked(name);
          yield* retireLegacyAuthorization(name);
        }),
      )
      .pipe(Effect.withSpan("ServerSecretStore.remove"));

  return ServerSecretStore.of({
    get,
    set,
    create,
    getOrCreateRandom,
    remove,
  });
});

export const layer = Layer.effect(ServerSecretStore, make);
