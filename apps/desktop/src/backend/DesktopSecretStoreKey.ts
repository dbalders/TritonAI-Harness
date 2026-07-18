import * as NodeCrypto from "node:crypto";

import * as Crypto from "effect/Crypto";
import * as SecretEnvelope from "@t3tools/shared/secretEnvelope";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const DATA_KEY_BYTES = 32;
const WRAPPED_KEY_FILE_NAME = "secret-store-key.v1.bin";
const INITIALIZED_FILE_NAME = "secret-store.v1.initialized";
const INITIALIZED_FILE_CONTENT = "TritonAI encrypted secret store v1\n";

const WrappedKeyRecord = Schema.Struct({
  version: Schema.Literal(1),
  active: Schema.String,
  previous: Schema.optionalKey(Schema.Array(Schema.String)),
  legacySecretFingerprints: Schema.Record(Schema.String, Schema.String),
});

const decodeWrappedKeyRecord = Schema.decodeEffect(Schema.fromJsonString(WrappedKeyRecord));

const keyError = (
  method: string,
  description: string,
  cause?: unknown,
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "InvalidData",
    module: "DesktopSecretStoreKey",
    method,
    description,
    ...(cause === undefined ? {} : { cause }),
  });

const unavailableError = (
  method: string,
  description: string,
  cause?: unknown,
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "DesktopSecretStoreKey",
    method,
    description,
    ...(cause === undefined ? {} : { cause }),
  });

export interface DesktopSecretStoreKeyMaterial {
  readonly keys: readonly [string, ...string[]];
  readonly legacySecretFingerprints: Readonly<Record<string, string>>;
}

const validateKeyring = Effect.fn("desktop.secretStoreKey.validate")(function* (record: {
  readonly active: string;
  readonly previous: ReadonlyArray<string>;
  readonly legacySecretFingerprints: Readonly<Record<string, string>>;
}) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const encoded of [record.active, ...record.previous]) {
    const decoded = yield* Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
      Effect.mapError(() => keyError("decode", "Secret-store key data is not valid base64.")),
    );
    if (decoded.byteLength !== DATA_KEY_BYTES) {
      return yield* keyError(
        "decode",
        `Secret-store keys must contain exactly ${DATA_KEY_BYTES} bytes.`,
      );
    }
    const canonical = Encoding.encodeBase64(decoded);
    if (!seen.has(canonical)) {
      normalized.push(canonical);
      seen.add(canonical);
    }
  }
  const legacySecretFingerprints = Object.create(null) as Record<string, string>;
  for (const [name, encoded] of Object.entries(record.legacySecretFingerprints)) {
    const decoded = yield* Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
      Effect.mapError(() =>
        keyError("decode", "Legacy secret fingerprint data is not valid base64."),
      ),
    );
    if (decoded.byteLength !== 32) {
      return yield* keyError("decode", "Legacy secret fingerprints must contain 32 bytes.");
    }
    legacySecretFingerprints[name] = Encoding.encodeBase64(decoded);
  }
  return {
    keys: [normalized[0]!, ...normalized.slice(1)] as const,
    legacySecretFingerprints,
  } satisfies DesktopSecretStoreKeyMaterial;
});

const decodeKeyring = (raw: string) =>
  decodeWrappedKeyRecord(raw).pipe(
    // Schema parse errors retain their input. Do not attach them as a cause,
    // because the decrypted record contains the data-encryption key.
    Effect.mapError(() => keyError("decode", "Wrapped secret-store key data is invalid.")),
    Effect.flatMap((record) =>
      validateKeyring({
        active: record.active,
        previous: record.previous ?? [],
        legacySecretFingerprints: record.legacySecretFingerprints,
      }),
    ),
  );

const encodeKeyring = (material: DesktopSecretStoreKeyMaterial): string =>
  JSON.stringify({
    version: 1,
    active: material.keys[0],
    previous: material.keys.slice(1),
    legacySecretFingerprints: material.legacySecretFingerprints,
  });

const fingerprintsEqual = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(
      ([name, fingerprint]) =>
        Object.prototype.hasOwnProperty.call(right, name) && right[name] === fingerprint,
    )
  );
};

const syncDirectory = Effect.fn("desktop.secretStoreKey.syncDirectory")(function* (
  directoryPath: string,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  if (environment.platform === "win32") return;
  const fileSystem = yield* FileSystem.FileSystem;
  yield* Effect.scoped(
    fileSystem.open(directoryPath, { flag: "r" }).pipe(Effect.flatMap((file) => file.sync)),
  );
});

export interface LegacySecretValue {
  readonly name: string;
  readonly value: Uint8Array;
}

export const authorizeLegacySecretValues = Effect.fn(
  "desktop.secretStoreKey.authorizeLegacyValues",
)(function* (
  values: ReadonlyArray<LegacySecretValue>,
  keys: readonly [Uint8Array, ...Uint8Array[]],
  location: string,
) {
  const dialog = yield* ElectronDialog.ElectronDialog;
  const fingerprints = Object.create(null) as Record<string, string>;
  const legacyValues: LegacySecretValue[] = [];
  for (const { name, value } of values) {
    // The magic prefix is reserved. Treat every matching value as an envelope
    // so a modified version byte cannot turn damaged ciphertext into approved
    // legacy plaintext.
    if (SecretEnvelope.hasServerSecretEnvelopeMagic(value)) {
      yield* Effect.try({
        try: () => SecretEnvelope.decodeServerSecretEnvelope(name, value, keys),
        catch: (cause) =>
          keyError(
            "migration",
            `Encrypted credential ${name} in ${location} could not be authenticated. Restore the protected key state or reconnect the integration.`,
            cause,
          ),
      });
      continue;
    }
    legacyValues.push({ name, value });
  }
  if (legacyValues.length === 0) return fingerprints;

  const confirmation = yield* dialog
    .showMessageBox({
      type: "warning",
      title: "Migrate existing credentials?",
      message: `TritonAI found legacy credential files in ${location}.`,
      detail:
        "Choose Migrate only if you just upgraded from an earlier Harness release. If you did not expect this prompt, cancel: the protected key may have been removed or damaged.",
      buttons: ["Cancel", "Migrate"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .pipe(
      Effect.mapError((cause) =>
        unavailableError("migration", "Unable to request legacy secret migration approval.", cause),
      ),
    );
  if (confirmation.response !== 1) {
    return yield* keyError("migration", "Legacy secret migration requires explicit user approval.");
  }

  for (const { name, value } of legacyValues) {
    fingerprints[name] = Encoding.encodeBase64(
      SecretEnvelope.fingerprintLegacyServerSecret(name, value, keys[0]),
    );
  }
  return fingerprints;
});

const captureLegacySecretFingerprints = Effect.fn(
  "desktop.secretStoreKey.captureLegacyFingerprints",
)(function* (secretsDir: string, activeKey: Uint8Array) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(secretsDir)
    .pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed([] as ReadonlyArray<string>)
          : Effect.fail(cause),
      ),
    );
  const values: LegacySecretValue[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".bin")) continue;
    const name = entry.slice(0, -".bin".length);
    const value = yield* fileSystem.readFile(environment.path.join(secretsDir, entry));
    values.push({ name, value: Uint8Array.from(value) });
  }
  return yield* authorizeLegacySecretValues(values, [activeKey], "the desktop credential store");
});

const ensureSecureBackend = Effect.fn("desktop.secretStoreKey.ensureSecureBackend")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const available = yield* safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError((cause) =>
      unavailableError(
        "availability",
        "Operating-system credential storage is unavailable.",
        cause,
      ),
    ),
  );
  if (!available) {
    return yield* unavailableError(
      "availability",
      "Operating-system credential storage is unavailable.",
    );
  }
  if (environment.platform !== "linux") return;

  const backend = yield* safeStorage.selectedStorageBackend.pipe(
    Effect.mapError((cause) =>
      unavailableError("backend", "Unable to identify the Linux credential backend.", cause),
    ),
  );
  if (backend === "basic_text" || backend === "unknown") {
    return yield* unavailableError(
      "backend",
      `Linux credential backend '${backend}' does not provide acceptable at-rest protection.`,
    );
  }
});

const persistWrappedKey = Effect.fn("desktop.secretStoreKey.persist")(function* (
  wrappedKeyPath: string,
  material: DesktopSecretStoreKeyMaterial,
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const encoded = encodeKeyring(material);
  const encrypted = yield* safeStorage
    .encryptString(encoded)
    .pipe(
      Effect.mapError((cause) =>
        unavailableError(
          "encrypt",
          "Operating-system credential storage could not protect the key.",
          cause,
        ),
      ),
    );
  const uuid = yield* crypto.randomUUIDv4;
  const tempPath = `${wrappedKeyPath}.${uuid}.tmp`;

  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(encrypted);
      yield* fileSystem.chmod(tempPath, 0o600);
      yield* file.sync;

      const persisted = yield* fileSystem.readFile(tempPath);
      const decrypted = yield* safeStorage
        .decryptString(Uint8Array.from(persisted))
        .pipe(
          Effect.mapError((cause) =>
            unavailableError(
              "verify",
              "Operating-system credential storage could not verify the protected key.",
              cause,
            ),
          ),
        );
      const verified = yield* decodeKeyring(decrypted);
      if (
        verified.keys.length !== material.keys.length ||
        verified.keys.some((key, index) => key !== material.keys[index]) ||
        !fingerprintsEqual(verified.legacySecretFingerprints, material.legacySecretFingerprints)
      ) {
        return yield* keyError("verify", "Protected secret-store key verification failed.");
      }

      yield* fileSystem.rename(tempPath, wrappedKeyPath);
      yield* fileSystem.chmod(wrappedKeyPath, 0o600);
      yield* syncDirectory(environment.path.dirname(wrappedKeyPath));
    }),
  ).pipe(
    Effect.catch((cause) =>
      fileSystem.remove(tempPath).pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
    ),
  );
});

const readInitializedMarker = Effect.fn("desktop.secretStoreKey.readInitializedMarker")(function* (
  initializedPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(initializedPath).pipe(
    Effect.map((contents) => {
      if (contents !== INITIALIZED_FILE_CONTENT) {
        return Option.some<"invalid">("invalid");
      }
      return Option.some<"initialized">("initialized");
    }),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<"initialized" | "invalid">())
        : Effect.fail(cause),
    ),
  );
});

const persistInitializedMarker = Effect.fn("desktop.secretStoreKey.persistInitializedMarker")(
  function* (initializedPath: string) {
    const crypto = yield* Crypto.Crypto;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const existing = yield* readInitializedMarker(initializedPath);
    if (Option.isSome(existing)) {
      if (existing.value === "invalid") {
        return yield* keyError("initialize", "Secret-store initialization metadata is invalid.");
      }
      return;
    }

    const uuid = yield* crypto.randomUUIDv4;
    const tempPath = `${initializedPath}.${uuid}.tmp`;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
        yield* file.writeAll(new TextEncoder().encode(INITIALIZED_FILE_CONTENT));
        yield* fileSystem.chmod(tempPath, 0o600);
        yield* file.sync;
        if ((yield* fileSystem.readFileString(tempPath)) !== INITIALIZED_FILE_CONTENT) {
          return yield* keyError("initialize", "Secret-store initialization verification failed.");
        }
        yield* fileSystem.rename(tempPath, initializedPath);
        yield* fileSystem.chmod(initializedPath, 0o600);
        yield* syncDirectory(environment.path.dirname(initializedPath));
      }),
    ).pipe(
      Effect.catch((cause) =>
        fileSystem.remove(tempPath).pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
      ),
    );
  },
);

const migrateLegacyValue = Effect.fn("desktop.secretStoreKey.migrateLegacyValue")(function* (
  secretsDir: string,
  name: string,
  expectedFingerprint: string,
  material: DesktopSecretStoreKeyMaterial,
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const secretPath = environment.path.join(secretsDir, `${name}.bin`);
  const storedOption = yield* fileSystem.readFile(secretPath).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(cause),
    ),
  );
  if (Option.isNone(storedOption)) return;

  const keys: Uint8Array[] = [];
  for (const encoded of material.keys) {
    keys.push(
      yield* Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
        Effect.mapError(() => keyError("migration", "Secret-store key data is invalid.")),
      ),
    );
  }
  const stored = Uint8Array.from(storedOption.value);
  const actualFingerprint = Encoding.encodeBase64(
    SecretEnvelope.fingerprintLegacyServerSecret(name, stored, keys[0]!),
  );
  const matchesApprovedLegacyValue =
    actualFingerprint.length === expectedFingerprint.length &&
    NodeCrypto.timingSafeEqual(
      Buffer.from(actualFingerprint, "utf8"),
      Buffer.from(expectedFingerprint, "utf8"),
    );
  if (!matchesApprovedLegacyValue && SecretEnvelope.hasServerSecretEnvelopeMagic(stored)) {
    yield* Effect.try({
      try: () => SecretEnvelope.decodeServerSecretEnvelope(name, stored, keys),
      catch: () => keyError("migration", "An encrypted legacy secret could not be authenticated."),
    });
    return;
  }
  if (!matchesApprovedLegacyValue) {
    return yield* keyError("migration", "A legacy secret changed after migration was approved.");
  }

  const envelope = yield* Effect.try({
    try: () => SecretEnvelope.encodeServerSecretEnvelope(name, stored, keys[0]!),
    catch: () => keyError("migration", "A legacy secret could not be encrypted."),
  });
  const uuid = yield* crypto.randomUUIDv4;
  const tempPath = `${secretPath}.${uuid}.tmp`;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(tempPath, { flag: "wx", mode: 0o600 });
      yield* file.writeAll(envelope);
      yield* fileSystem.chmod(tempPath, 0o600);
      yield* file.sync;
      const persisted = yield* fileSystem.readFile(tempPath);
      const verified = yield* Effect.try({
        try: () => SecretEnvelope.decodeServerSecretEnvelope(name, persisted, keys),
        catch: () => keyError("migration", "Legacy secret migration verification failed."),
      });
      if (
        verified.keyIndex !== 0 ||
        verified.value.byteLength !== stored.byteLength ||
        !NodeCrypto.timingSafeEqual(Buffer.from(verified.value), Buffer.from(stored))
      ) {
        return yield* keyError("migration", "Legacy secret migration verification failed.");
      }
      yield* fileSystem.rename(tempPath, secretPath);
      yield* fileSystem.chmod(secretPath, 0o600);
      yield* syncDirectory(secretsDir);
    }),
  ).pipe(
    Effect.catch((cause) =>
      fileSystem.remove(tempPath).pipe(Effect.ignore, Effect.andThen(Effect.fail(cause))),
    ),
  );
});

const migratePendingLegacySecrets = Effect.fn("desktop.secretStoreKey.migratePending")(function* (
  wrappedKeyPath: string,
  secretsDir: string,
  material: DesktopSecretStoreKeyMaterial,
) {
  const remaining = { ...material.legacySecretFingerprints };
  for (const [name, fingerprint] of Object.entries(material.legacySecretFingerprints)) {
    yield* migrateLegacyValue(secretsDir, name, fingerprint, material);
    delete remaining[name];
    // Persist each consumption in the OS-wrapped record before the server
    // can start. A later process therefore cannot replay the old plaintext
    // under a migration authorization that only disappeared from memory.
    yield* persistWrappedKey(wrappedKeyPath, {
      keys: material.keys,
      legacySecretFingerprints: remaining,
    });
  }
  return { keys: material.keys, legacySecretFingerprints: remaining };
});

export const resolve = Effect.fn("desktop.secretStoreKey.resolve")(function* () {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const wrappedKeyPath = environment.path.join(environment.stateDir, WRAPPED_KEY_FILE_NAME);
  const initializedPath = environment.path.join(environment.stateDir, INITIALIZED_FILE_NAME);

  yield* ensureSecureBackend();
  yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
  yield* fileSystem.chmod(environment.stateDir, 0o700);

  const wrapped = yield* fileSystem.readFile(wrappedKeyPath).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(cause),
    ),
  );
  const initialized = yield* readInitializedMarker(initializedPath);
  if (Option.isSome(initialized) && initialized.value === "invalid") {
    return yield* keyError("initialize", "Secret-store initialization metadata is invalid.");
  }
  if (Option.isNone(wrapped) && Option.isSome(initialized)) {
    return yield* keyError(
      "initialize",
      "The OS-protected secret-store key is missing from an initialized store.",
    );
  }

  const loadedMaterial = yield* Option.match(wrapped, {
    onNone: () =>
      Effect.gen(function* () {
        const activeKey = yield* crypto.randomBytes(DATA_KEY_BYTES);
        const legacySecretFingerprints = yield* captureLegacySecretFingerprints(
          environment.path.join(environment.stateDir, "secrets"),
          activeKey,
        );
        return {
          keys: [Encoding.encodeBase64(activeKey)] as const,
          legacySecretFingerprints,
        } satisfies DesktopSecretStoreKeyMaterial;
      }),
    onSome: (bytes) =>
      safeStorage.decryptString(Uint8Array.from(bytes)).pipe(
        Effect.mapError((cause) =>
          unavailableError(
            "decrypt",
            "Operating-system credential storage could not unlock the secret-store key.",
            cause,
          ),
        ),
        Effect.flatMap(decodeKeyring),
      ),
  });

  if (Option.isNone(wrapped)) {
    // Make the generated data key recoverable before marking the store as
    // initialized or replacing plaintext. The marker is the authoritative
    // discriminator between a legacy store and a lost-key encrypted store.
    yield* persistWrappedKey(wrappedKeyPath, loadedMaterial);
  }
  yield* persistInitializedMarker(initializedPath);
  const material = yield* migratePendingLegacySecrets(
    wrappedKeyPath,
    environment.path.join(environment.stateDir, "secrets"),
    loadedMaterial,
  );

  // Re-wrap on every desktop launch. This lets Keychain, DPAPI, or the secure
  // Linux credential backend rotate its own protection without changing the
  // server-side data key or the plugin-facing store API.
  yield* persistWrappedKey(wrappedKeyPath, material);
  return material;
});
