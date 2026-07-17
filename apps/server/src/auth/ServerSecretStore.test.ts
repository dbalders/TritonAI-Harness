import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as SecretEnvelope from "@t3tools/shared/secretEnvelope";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const ACTIVE_KEY = "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo=";
const ROTATED_KEY = "WVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVk=";
const TestSecretStoreKeyring = Schema.Struct({
  version: Schema.Literal(1),
  active: Schema.String,
  previous: Schema.Array(Schema.String),
  legacySecretFingerprints: Schema.Record(Schema.String, Schema.String),
});
const encodeTestSecretStoreKeyring = Schema.encodeEffect(
  Schema.fromJsonString(TestSecretStoreKeyring),
);
const decodeTestSecretStoreKeyring = Schema.decodeEffect(
  Schema.fromJsonString(TestSecretStoreKeyring),
);

interface TestLayerOptions {
  readonly baseDir?: string;
  readonly mode?: ServerConfig.RuntimeMode;
  readonly secretStoreKeys?: ReadonlyArray<string> | null;
  readonly legacySecretFingerprints?: Readonly<Record<string, string>>;
  readonly secretStoreKeyFilePath?: string | null;
  readonly fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>;
}

const makeServerConfigLayer = (options: TestLayerOptions = {}) => {
  const baseLayer = ServerConfig.layerTest(
    process.cwd(),
    options.baseDir ?? { prefix: "t3-secret-store-test-" },
  );
  const secretStoreKeys =
    options.secretStoreKeys === null ? undefined : (options.secretStoreKeys ?? [ACTIVE_KEY]);
  return Layer.effect(
    ServerConfig.ServerConfig,
    Effect.service(ServerConfig.ServerConfig).pipe(
      Effect.flatMap((config) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const fingerprints = options.legacySecretFingerprints ?? {};
          const keyFilePath =
            options.secretStoreKeyFilePath === null
              ? undefined
              : (options.secretStoreKeyFilePath ??
                (Object.keys(fingerprints).length === 0
                  ? undefined
                  : `${config.stateDir}/test-secret-keyring.json`));
          if (keyFilePath !== undefined && !(yield* fileSystem.exists(keyFilePath))) {
            const encoded = yield* encodeTestSecretStoreKeyring({
              version: 1,
              active: secretStoreKeys?.[0] ?? ACTIVE_KEY,
              previous: secretStoreKeys?.slice(1) ?? [],
              legacySecretFingerprints: fingerprints,
            });
            yield* fileSystem.writeFileString(keyFilePath, encoded);
            yield* fileSystem.chmod(keyFilePath, 0o600);
          }
          return ServerConfig.make({
            ...config,
            mode: options.mode ?? config.mode,
            secretStoreKeys,
            legacySecretFingerprints: fingerprints,
            ...(keyFilePath === undefined ? {} : { secretStoreKeyFilePath: keyFilePath }),
          });
        }),
      ),
    ),
  ).pipe(Layer.provide(baseLayer));
};

const legacyFingerprint = (name: string, value: Uint8Array, key = ACTIVE_KEY): string =>
  Buffer.from(
    SecretEnvelope.fingerprintLegacyServerSecret(name, value, Buffer.from(key, "base64")),
  ).toString("base64");

const makeServerSecretStoreLayer = (options: TestLayerOptions = {}) => {
  const configLayer = makeServerConfigLayer(options);
  const layer = ServerSecretStore.layer.pipe(Layer.provideMerge(configLayer));
  return options.fileSystemLayer === undefined
    ? layer
    : layer.pipe(Layer.provideMerge(options.fileSystemLayer));
};

const secretPath = (config: ServerConfig.ServerConfig["Service"], name: string) =>
  config.secretsDir.endsWith("/")
    ? `${config.secretsDir}${name}.bin`
    : `${config.secretsDir}/${name}.bin`;

const PermissionDeniedFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const RenameFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const FailureAfterPublishFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      link: (from, to) =>
        fileSystem.link(from, to).pipe(
          Effect.andThen(
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "link",
                pathOrDescriptor: `${String(from)} -> ${String(to)}`,
                description: "Injected failure after publishing the secret file.",
              }),
            ),
          ),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const RemoveFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      remove: (path, options) =>
        String(path).endsWith(".lock")
          ? fileSystem.remove(path, options)
          : Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "remove",
                pathOrDescriptor: String(path),
                description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
              }),
            ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      assert.isTrue(Option.isNone(yield* secretStore.get("missing-secret")));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("encrypts new values while preserving the caller-facing bytes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const value = new TextEncoder().encode("graph-refresh-token-value");

      yield* secretStore.set("integration-microsoft-365--oauth", value);
      const raw = yield* fileSystem.readFile(
        secretPath(config, "integration-microsoft-365--oauth"),
      );
      const readBack = Option.getOrThrow(
        yield* secretStore.get("integration-microsoft-365--oauth"),
      );

      assert.isFalse(Buffer.from(raw).includes(Buffer.from(value)));
      assert.deepEqual(Array.from(readBack), Array.from(value));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("migrates a legacy plaintext file after encrypted verification", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const value = new TextEncoder().encode("legacy-refresh-token");
      const path = secretPath(config, "integration-microsoft-365--oauth");
      yield* fileSystem.writeFile(path, value);

      const migrated = Option.getOrThrow(
        yield* secretStore.get("integration-microsoft-365--oauth"),
      );
      const raw = yield* fileSystem.readFile(path);

      assert.deepEqual(Array.from(migrated), Array.from(value));
      assert.equal(new TextDecoder().decode(raw.subarray(0, 8)), "T3SECRET");
      assert.isFalse(Buffer.from(raw).includes(Buffer.from(value)));
    }).pipe(
      Effect.provide(
        makeServerSecretStoreLayer({
          legacySecretFingerprints: {
            "integration-microsoft-365--oauth": legacyFingerprint(
              "integration-microsoft-365--oauth",
              new TextEncoder().encode("legacy-refresh-token"),
            ),
          },
        }),
      ),
    ),
  );

  it.effect("migrates and retires a legacy name matching an object prototype property", () => {
    const name = "__proto__";
    const value = new TextEncoder().encode("legacy-prototype-value");
    const fingerprint = legacyFingerprint(name, value);
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const path = secretPath(config, name);
      yield* fileSystem.writeFile(path, value);

      const migrated = Option.getOrThrow(yield* secretStore.get(name));
      const keyring = yield* fileSystem
        .readFileString(config.secretStoreKeyFilePath!)
        .pipe(Effect.flatMap(decodeTestSecretStoreKeyring));
      assert.deepEqual(Array.from(migrated), Array.from(value));
      assert.isTrue(SecretEnvelope.hasServerSecretEnvelopeMagic(yield* fileSystem.readFile(path)));
      assert.isFalse(Object.prototype.hasOwnProperty.call(keyring.legacySecretFingerprints, name));
    }).pipe(
      Effect.provide(
        makeServerSecretStoreLayer({
          legacySecretFingerprints: { [name]: fingerprint },
        }),
      ),
    );
  });

  it.effect("accepts one-process migration authorization from the desktop WSL bootstrap", () => {
    const name = "integration-microsoft-365--oauth";
    const value = new TextEncoder().encode("wsl-legacy-refresh-token");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const path = secretPath(config, name);
      yield* fileSystem.writeFile(path, value);

      const migrated = Option.getOrThrow(yield* secretStore.get(name));
      assert.deepEqual(Array.from(migrated), Array.from(value));
      assert.isUndefined(config.secretStoreKeyFilePath);
      assert.isTrue(SecretEnvelope.hasServerSecretEnvelopeMagic(yield* fileSystem.readFile(path)));
    }).pipe(
      Effect.provide(
        makeServerSecretStoreLayer({
          mode: "desktop",
          secretStoreKeyFilePath: null,
          legacySecretFingerprints: { [name]: legacyFingerprint(name, value) },
        }),
      ),
    );
  });

  it.effect("preserves legacy plaintext when migration persistence fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const value = new TextEncoder().encode("legacy-value-that-must-survive");
      const path = secretPath(config, "legacy-oauth");
      yield* fileSystem.writeFile(path, value);

      const error = yield* Effect.flip(secretStore.get("legacy-oauth"));
      const stillPlaintext = yield* fileSystem.readFile(path);

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.deepEqual(Array.from(stillPlaintext), Array.from(value));
    }).pipe(
      Effect.provide(
        makeServerSecretStoreLayer({
          fileSystemLayer: RenameFailureFileSystemLayer,
          legacySecretFingerprints: {
            "legacy-oauth": legacyFingerprint(
              "legacy-oauth",
              new TextEncoder().encode("legacy-value-that-must-survive"),
            ),
          },
        }),
      ),
    ),
  );

  it.effect("durably rejects replay after a headless migration and restart", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-legacy-consumption-",
      });
      const name = "legacy-oauth";
      const value = new TextEncoder().encode("one-time-legacy-value");
      const fingerprint = legacyFingerprint(name, value);

      const locations = yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const path = secretPath(config, name);
        yield* fileSystem.writeFile(path, value);
        assert.isTrue(Option.isSome(yield* secretStore.get(name)));
        return { path, keyFilePath: config.secretStoreKeyFilePath! };
      }).pipe(
        Effect.provide(
          makeServerSecretStoreLayer({
            baseDir,
            legacySecretFingerprints: { [name]: fingerprint },
          }),
        ),
      );
      const consumedKeyring = yield* fileSystem
        .readFileString(locations.keyFilePath)
        .pipe(Effect.flatMap(decodeTestSecretStoreKeyring));
      assert.isUndefined(consumedKeyring.legacySecretFingerprints[name]);

      yield* fileSystem.writeFile(locations.path, value);
      const replayError = yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        return yield* Effect.flip(secretStore.get(name));
      }).pipe(
        Effect.provide(
          makeServerSecretStoreLayer({
            baseDir,
            secretStoreKeyFilePath: locations.keyFilePath,
            legacySecretFingerprints: consumedKeyring.legacySecretFingerprints,
          }),
        ),
      );
      assert.instanceOf(replayError, ServerSecretStore.SecretStoreDecodeError);
    }).pipe(Effect.scoped),
  );

  it.effect("serializes migration authorization retirement across store instances", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-concurrent-migration-",
      });
      const firstName = "legacy-first";
      const secondName = "legacy-second";
      const firstValue = new TextEncoder().encode("first-legacy-value");
      const secondValue = new TextEncoder().encode("second-legacy-value");
      const fingerprints = {
        [firstName]: legacyFingerprint(firstName, firstValue),
        [secondName]: legacyFingerprint(secondName, secondValue),
      };

      const locations = yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* ServerSecretStore.ServerSecretStore;
        yield* fileSystem.writeFile(secretPath(config, firstName), firstValue);
        yield* fileSystem.writeFile(secretPath(config, secondName), secondValue);
        return { keyFilePath: config.secretStoreKeyFilePath! };
      }).pipe(
        Effect.provide(
          makeServerSecretStoreLayer({
            baseDir,
            legacySecretFingerprints: fingerprints,
          }),
        ),
      );

      let lockAcquisitions = 0;
      const delayedLockLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const underlying = yield* FileSystem.FileSystem;
          return {
            ...underlying,
            open: (filePath, options) => {
              const open = underlying.open(filePath, options);
              if (filePath !== `${locations.keyFilePath}.lock` || options?.flag !== "wx") {
                return open;
              }
              return open.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    lockAcquisitions += 1;
                  }),
                ),
                Effect.tap(() => Effect.sleep("100 millis")),
              );
            },
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const initializeStore = () =>
        Effect.service(ServerSecretStore.ServerSecretStore).pipe(
          Effect.provide(
            Layer.fresh(
              makeServerSecretStoreLayer({
                baseDir,
                legacySecretFingerprints: fingerprints,
                secretStoreKeyFilePath: locations.keyFilePath,
                fileSystemLayer: delayedLockLayer,
              }),
            ),
          ),
        );
      const [firstStore, secondStore, thirdStore] = yield* Effect.all(
        [initializeStore(), initializeStore(), initializeStore()],
        { concurrency: "unbounded" },
      );

      const migrated = yield* Effect.all(
        [firstStore.get(firstName), secondStore.get(firstName), thirdStore.get(secondName)],
        { concurrency: "unbounded" },
      );
      assert.isTrue(migrated.every(Option.isSome));

      const consumedKeyring = yield* fileSystem
        .readFileString(locations.keyFilePath)
        .pipe(Effect.flatMap(decodeTestSecretStoreKeyring));
      assert.equal(lockAcquisitions, 3);
      assert.isUndefined(consumedKeyring.legacySecretFingerprints[firstName]);
      assert.isUndefined(consumedKeyring.legacySecretFingerprints[secondName]);
      assert.isFalse(yield* fileSystem.exists(`${locations.keyFilePath}.lock`));
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("prevents a cross-process legacy migration from overwriting a newer value", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-migration-write-race-",
      });
      const name = "legacy-oauth";
      const legacyValue = new TextEncoder().encode("legacy-value");
      const newerValue = new TextEncoder().encode("newer-value");
      const fingerprint = legacyFingerprint(name, legacyValue);

      const locations = yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* ServerSecretStore.ServerSecretStore;
        const path = secretPath(config, name);
        yield* fileSystem.writeFile(path, legacyValue);
        return {
          path,
          lockPath: `${path}.lock`,
          keyFilePath: config.secretStoreKeyFilePath!,
        };
      }).pipe(
        Effect.provide(
          makeServerSecretStoreLayer({
            baseDir,
            legacySecretFingerprints: { [name]: fingerprint },
          }),
        ),
      );

      const migrationReady = yield* Deferred.make<void>();
      const allowMigrationPublish = yield* Deferred.make<void>();
      const writerObservedLock = yield* Deferred.make<void>();
      const pausedMigrationLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const underlying = yield* FileSystem.FileSystem;
          return {
            ...underlying,
            rename: (from, to) => {
              const isSecretReplacement =
                String(to) === locations.path &&
                String(from).startsWith(`${locations.path}.`) &&
                String(from).endsWith(".tmp");
              return isSecretReplacement
                ? Deferred.succeed(migrationReady, undefined).pipe(
                    Effect.andThen(Deferred.await(allowMigrationPublish)),
                    Effect.andThen(underlying.rename(from, to)),
                  )
                : underlying.rename(from, to);
            },
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const blockedWriterLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const underlying = yield* FileSystem.FileSystem;
          return {
            ...underlying,
            open: (filePath, options) => {
              const opened = underlying.open(filePath, options);
              if (String(filePath) !== locations.lockPath || options?.flag !== "wx") {
                return opened;
              }
              return opened.pipe(
                Effect.tapError(() => Deferred.succeed(writerObservedLock, undefined)),
              );
            },
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const initializeStore = (fileSystemLayer: Layer.Layer<FileSystem.FileSystem>) =>
        Effect.service(ServerSecretStore.ServerSecretStore).pipe(
          Effect.provide(
            Layer.fresh(
              makeServerSecretStoreLayer({
                baseDir,
                legacySecretFingerprints: { [name]: fingerprint },
                secretStoreKeyFilePath: locations.keyFilePath,
                fileSystemLayer,
              }),
            ),
          ),
        );
      const [migratingStore, writingStore] = yield* Effect.all(
        [initializeStore(pausedMigrationLayer), initializeStore(blockedWriterLayer)],
        { concurrency: "unbounded" },
      );

      const migrationFiber = yield* migratingStore.get(name).pipe(Effect.forkScoped);
      yield* Deferred.await(migrationReady);
      const writerFiber = yield* writingStore.set(name, newerValue).pipe(Effect.forkScoped);
      yield* Deferred.await(writerObservedLock);
      yield* Deferred.succeed(allowMigrationPublish, undefined);

      const migrated = Option.getOrThrow(yield* Fiber.join(migrationFiber));
      yield* Fiber.join(writerFiber);
      const finalValue = Option.getOrThrow(yield* writingStore.get(name));
      assert.deepEqual(Array.from(migrated), Array.from(legacyValue));
      assert.deepEqual(Array.from(finalValue), Array.from(newerValue));
      assert.isFalse(yield* fileSystem.exists(locations.lockPath));
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("removes an owned lock when lock initialization fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-lock-initialization-failure-",
      });
      const name = "legacy-oauth";
      const value = new TextEncoder().encode("recoverable-legacy-value");
      const fingerprint = legacyFingerprint(name, value);
      const locations = yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* ServerSecretStore.ServerSecretStore;
        yield* fileSystem.writeFile(secretPath(config, name), value);
        return { keyFilePath: config.secretStoreKeyFilePath! };
      }).pipe(
        Effect.provide(
          makeServerSecretStoreLayer({
            baseDir,
            legacySecretFingerprints: { [name]: fingerprint },
          }),
        ),
      );
      let injectedFailure = false;
      const failedLockInitializationLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const underlying = yield* FileSystem.FileSystem;
          return {
            ...underlying,
            open: (filePath, options) =>
              underlying.open(filePath, options).pipe(
                Effect.map((file) => {
                  if (
                    injectedFailure ||
                    filePath !== `${locations.keyFilePath}.lock` ||
                    options?.flag !== "wx"
                  ) {
                    return file;
                  }
                  injectedFailure = true;
                  return {
                    ...file,
                    writeAll: () =>
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "WriteZero",
                          module: "FileSystem",
                          method: "writeAll",
                          pathOrDescriptor: filePath,
                          description: "Injected lock owner write failure.",
                        }),
                      ),
                  } satisfies FileSystem.File;
                }),
              ),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const migrationError = yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        return yield* Effect.flip(secretStore.get(name));
      }).pipe(
        Effect.provide(
          Layer.fresh(
            makeServerSecretStoreLayer({
              baseDir,
              legacySecretFingerprints: { [name]: fingerprint },
              secretStoreKeyFilePath: locations.keyFilePath,
              fileSystemLayer: failedLockInitializationLayer,
            }),
          ),
        ),
      );
      assert.instanceOf(migrationError, ServerSecretStore.SecretStorePersistError);
      assert.isFalse(yield* fileSystem.exists(`${locations.keyFilePath}.lock`));
      const retainedKeyring = yield* fileSystem
        .readFileString(locations.keyFilePath)
        .pipe(Effect.flatMap(decodeTestSecretStoreKeyring));
      assert.equal(retainedKeyring.legacySecretFingerprints[name], fingerprint);

      const recovered = yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        return yield* secretStore.get(name);
      }).pipe(
        Effect.provide(
          Layer.fresh(
            makeServerSecretStoreLayer({
              baseDir,
              legacySecretFingerprints: { [name]: fingerprint },
              secretStoreKeyFilePath: locations.keyFilePath,
            }),
          ),
        ),
      );
      assert.isTrue(Option.isSome(recovered));
      assert.isFalse(yield* fileSystem.exists(`${locations.keyFilePath}.lock`));
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces a failure to remove a raw-key retirement temporary file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-keyring-temp-cleanup-failure-",
      });
      const name = "legacy-oauth";
      const value = new TextEncoder().encode("legacy-value");
      const fingerprint = legacyFingerprint(name, value);
      const locations = yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* ServerSecretStore.ServerSecretStore;
        yield* fileSystem.writeFile(secretPath(config, name), value);
        return { keyFilePath: config.secretStoreKeyFilePath! };
      }).pipe(
        Effect.provide(
          makeServerSecretStoreLayer({
            baseDir,
            legacySecretFingerprints: { [name]: fingerprint },
          }),
        ),
      );

      const failedCleanupLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const underlying = yield* FileSystem.FileSystem;
          const isKeyringTemp = (filePath: string) =>
            filePath.startsWith(`${locations.keyFilePath}.`) && filePath.endsWith(".tmp");
          return {
            ...underlying,
            rename: (from, to) =>
              isKeyringTemp(String(from)) && String(to) === locations.keyFilePath
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: `${String(from)} -> ${String(to)}`,
                      description: "Injected keyring rename failure.",
                    }),
                  )
                : underlying.rename(from, to),
            remove: (filePath, options) =>
              isKeyringTemp(String(filePath))
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "remove",
                      pathOrDescriptor: String(filePath),
                      description: "Injected raw-key temporary file cleanup failure.",
                    }),
                  )
                : underlying.remove(filePath, options),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const error = yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        return yield* Effect.flip(secretStore.get(name));
      }).pipe(
        Effect.provide(
          Layer.fresh(
            makeServerSecretStoreLayer({
              baseDir,
              legacySecretFingerprints: { [name]: fingerprint },
              secretStoreKeyFilePath: locations.keyFilePath,
              fileSystemLayer: failedCleanupLayer,
            }),
          ),
        ),
      );
      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.equal(error.resource, "external secret-store keyring temporary file cleanup");
      assert.instanceOf(error.cause, AggregateError);
      assert.isFalse(yield* fileSystem.exists(`${locations.keyFilePath}.lock`));
      const keyringDirectory = locations.keyFilePath.slice(
        0,
        locations.keyFilePath.lastIndexOf("/"),
      );
      const entries = yield* fileSystem.readDirectory(keyringDirectory);
      assert.isTrue(
        entries.some(
          (entry) => entry.startsWith("test-secret-keyring.json.") && entry.endsWith(".tmp"),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails closed when ciphertext is tampered", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const path = secretPath(config, "oauth");
      yield* secretStore.set("oauth", new TextEncoder().encode("token"));
      const raw = Uint8Array.from(yield* fileSystem.readFile(path));
      raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
      yield* fileSystem.writeFile(path, raw);

      const error = yield* Effect.flip(secretStore.get("oauth"));
      assert.instanceOf(error, ServerSecretStore.SecretStoreDecodeError);
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("does not reclassify a damaged envelope header as legacy plaintext", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const path = secretPath(config, "oauth");
      yield* secretStore.set("oauth", new TextEncoder().encode("token"));
      const raw = Uint8Array.from(yield* fileSystem.readFile(path));
      raw[0] = (raw[0] ?? 0) ^ 0xff;
      yield* fileSystem.writeFile(path, raw);

      const error = yield* Effect.flip(secretStore.get("oauth"));
      assert.instanceOf(error, ServerSecretStore.SecretStoreDecodeError);
      assert.deepEqual(Array.from(yield* fileSystem.readFile(path)), Array.from(raw));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("rejects plaintext that was not captured before encrypted storage was enabled", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* fileSystem.writeFile(
        secretPath(config, "oauth"),
        new TextEncoder().encode("untrusted-plaintext"),
      );

      const error = yield* Effect.flip(secretStore.get("oauth"));
      assert.instanceOf(error, ServerSecretStore.SecretStoreDecodeError);
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("migrates fingerprinted legacy bytes that begin with the envelope magic", () => {
    const name = "legacy-magic";
    const value = new TextEncoder().encode("T3SECRET legacy bytes");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* fileSystem.writeFile(secretPath(config, name), value);

      const migrated = Option.getOrThrow(yield* secretStore.get(name));
      assert.deepEqual(Array.from(migrated), Array.from(value));
      assert.isFalse(
        Buffer.from(yield* fileSystem.readFile(secretPath(config, name))).includes(
          Buffer.from(value),
        ),
      );
    }).pipe(
      Effect.provide(
        makeServerSecretStoreLayer({
          legacySecretFingerprints: { [name]: legacyFingerprint(name, value) },
        }),
      ),
    );
  });

  it.effect("authenticates the canonical name to reject ciphertext swaps", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* secretStore.set("first", new TextEncoder().encode("token"));
      const raw = yield* fileSystem.readFile(secretPath(config, "first"));
      yield* fileSystem.writeFile(secretPath(config, "second"), raw);

      const error = yield* Effect.flip(secretStore.get("second"));
      assert.instanceOf(error, ServerSecretStore.SecretStoreDecodeError);
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("lazily rotates an envelope through configured fallback keys", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-key-rotation-" });
      const value = new TextEncoder().encode("rotating-secret");

      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        yield* secretStore.set("oauth", value);
      }).pipe(
        Effect.provide(makeServerSecretStoreLayer({ baseDir, secretStoreKeys: [ACTIVE_KEY] })),
      );

      const rotated = yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        return Option.getOrThrow(yield* secretStore.get("oauth"));
      }).pipe(
        Effect.provide(
          makeServerSecretStoreLayer({
            baseDir,
            secretStoreKeys: [ROTATED_KEY, ACTIVE_KEY],
          }),
        ),
      );
      assert.deepEqual(Array.from(rotated), Array.from(value));

      const oldKeyError = yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        return yield* Effect.flip(secretStore.get("oauth"));
      }).pipe(
        Effect.provide(makeServerSecretStoreLayer({ baseDir, secretStoreKeys: [ACTIVE_KEY] })),
      );
      assert.instanceOf(oldKeyError, ServerSecretStore.SecretStoreDecodeError);
    }).pipe(Effect.scoped),
  );

  it.effect("fails closed when no encryption-key provider is configured", () =>
    Effect.gen(function* () {
      const error = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(makeServerSecretStoreLayer({ secretStoreKeys: null })),
        Effect.flip,
      );
      assert.instanceOf(error, ServerSecretStore.SecretStoreKeyError);
      assert.equal(error.reason, "missing-provider");
    }),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("returns one persisted value when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const values = yield* Effect.all(
        Array.from({ length: 32 }, () => secretStore.getOrCreateRandom("session-signing-key", 32)),
        { concurrency: "unbounded" },
      );
      const persisted = Option.getOrThrow(yield* secretStore.get("session-signing-key"));
      for (const value of values) {
        assert.deepEqual(Array.from(value), Array.from(persisted));
      }
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("returns the persisted winner when independent store instances race", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-independent-secret-race-",
      });
      const initialize = Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        return yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      });
      const [first, second] = yield* Effect.all(
        [
          initialize.pipe(Effect.provide(Layer.fresh(makeServerSecretStoreLayer({ baseDir })))),
          initialize.pipe(Effect.provide(Layer.fresh(makeServerSecretStoreLayer({ baseDir })))),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("serializes removal behind another store instance's active create", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-independent-secret-remove-race-",
      });
      const tempOpened = yield* Deferred.make<void>();
      const continueCreate = yield* Deferred.make<void>();
      const removeObservedLock = yield* Deferred.make<void>();
      let delayed = false;
      const delayedTemporaryOpenLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const underlying = yield* FileSystem.FileSystem;
          return {
            ...underlying,
            open: (filePath, options) => {
              const opened = underlying.open(filePath, options);
              if (options?.flag === "wx" && String(filePath).endsWith("oauth.bin.lock")) {
                return opened.pipe(
                  Effect.tapError(() => Deferred.succeed(removeObservedLock, undefined)),
                );
              }
              if (
                delayed ||
                options?.flag !== "wx" ||
                !String(filePath).includes("oauth.bin.") ||
                !String(filePath).endsWith(".tmp")
              ) {
                return opened;
              }
              delayed = true;
              return opened.pipe(
                Effect.tap(() => Deferred.succeed(tempOpened, undefined)),
                Effect.tap(() => Deferred.await(continueCreate)),
              );
            },
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const initializeStore = () =>
        Effect.service(ServerSecretStore.ServerSecretStore).pipe(
          Effect.provide(
            Layer.fresh(
              makeServerSecretStoreLayer({
                baseDir,
                fileSystemLayer: delayedTemporaryOpenLayer,
              }),
            ),
          ),
        );
      const [creatingStore, removingStore] = yield* Effect.all(
        [initializeStore(), initializeStore()],
        { concurrency: "unbounded" },
      );
      const value = new TextEncoder().encode("concurrently-created-value");
      const createFiber = yield* creatingStore.create("oauth", value).pipe(Effect.forkScoped);
      yield* Deferred.await(tempOpened);

      const removeFiber = yield* removingStore.remove("oauth").pipe(Effect.forkScoped);
      yield* Deferred.await(removeObservedLock);
      yield* Deferred.succeed(continueCreate, undefined);
      yield* Fiber.join(createFiber);
      yield* Fiber.join(removeFiber);

      assert.isTrue(Option.isNone(yield* creatingStore.get("oauth")));
      const entries = yield* fileSystem.readDirectory(`${baseDir}/userdata/secrets`);
      assert.isFalse(entries.some((entry) => entry.endsWith(".tmp")));
    }).pipe(Effect.scoped, TestClock.withLive),
  );

  it.effect("never deletes a canonical secret after a failed publish", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const value = new TextEncoder().encode("published-before-injected-failure");

      const error = yield* Effect.flip(secretStore.create("oauth", value));
      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");

      const persisted = Option.getOrThrow(yield* secretStore.get("oauth"));
      assert.deepEqual(Array.from(persisted), Array.from(value));
      const entries = yield* fileSystem.readDirectory(config.secretsDir);
      assert.isFalse(
        entries.some((entry) => entry.startsWith("oauth.bin.") && entry.endsWith(".tmp")),
      );
    }).pipe(
      Effect.provide(
        makeServerSecretStoreLayer({ fileSystemLayer: FailureAfterPublishFileSystemLayer }),
      ),
    ),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () => {
    const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
    const recordingFileSystemLayer = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return {
          ...fileSystem,
          chmod: (path, mode) =>
            fileSystem
              .chmod(path, mode)
              .pipe(
                Effect.tap(() => Effect.sync(() => chmodCalls.push({ path: String(path), mode }))),
              ),
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));
      assert.isTrue(
        chmodCalls.some((call) => call.mode === 0o700 && call.path.endsWith("/secrets")),
      );
      assert.isAtLeast(chmodCalls.filter((call) => call.mode === 0o600).length, 2);
    }).pipe(
      Effect.provide(makeServerSecretStoreLayer({ fileSystemLayer: recordingFileSystemLayer })),
    );
  });

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));
      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(
      Effect.provide(
        makeServerSecretStoreLayer({ fileSystemLayer: PermissionDeniedFileSystemLayer }),
      ),
    ),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );
      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(
      Effect.provide(makeServerSecretStoreLayer({ fileSystemLayer: RenameFailureFileSystemLayer })),
    ),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));
      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(
      Effect.provide(makeServerSecretStoreLayer({ fileSystemLayer: RemoveFailureFileSystemLayer })),
    ),
  );
});
