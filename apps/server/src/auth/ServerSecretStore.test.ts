import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as SecretEnvelope from "@t3tools/shared/secretEnvelope";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

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
  readonly secretStoreKeys?: ReadonlyArray<string> | null;
  readonly legacySecretFingerprints?: Readonly<Record<string, string>>;
  readonly secretStoreKeyFilePath?: string;
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
            options.secretStoreKeyFilePath ??
            (Object.keys(fingerprints).length === 0
              ? undefined
              : `${config.stateDir}/test-secret-keyring.json`);
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

const RemoveFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
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
      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = Option.getOrThrow(yield* secretStore.get("session-signing-key"));
      assert.deepEqual(Array.from(first), Array.from(persisted));
      assert.deepEqual(Array.from(second), Array.from(persisted));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
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
