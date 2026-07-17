import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as SecretEnvelope from "@t3tools/shared/secretEnvelope";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSecretStoreKey from "./DesktopSecretStoreKey.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const makeEnvironmentLayer = (baseDir: string, platform: NodeJS.Platform) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform,
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          T3CODE_MODE: "desktop",
        }),
      ),
    ),
  );

const makeSafeStorageLayer = (options?: {
  readonly available?: boolean;
  readonly backend?: ElectronSafeStorage.ElectronSafeStorageBackend;
  readonly selectedBackendEffect?: Effect.Effect<
    ElectronSafeStorage.ElectronSafeStorageBackend,
    ElectronSafeStorage.ElectronSafeStorageAvailabilityError
  >;
}) =>
  Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(options?.available ?? true),
    selectedStorageBackend:
      options?.selectedBackendEffect ?? Effect.succeed(options?.backend ?? "gnome_libsecret"),
    encryptString: (value) =>
      Effect.succeed(Uint8Array.from(textEncoder.encode(value), (byte) => byte ^ 0xa5)),
    decryptString: (value) =>
      Effect.succeed(textDecoder.decode(Uint8Array.from(value, (byte) => byte ^ 0xa5))),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

const makeDialogLayer = (response = 0) =>
  Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.succeed(Option.none()),
    confirm: () => Effect.succeed(false),
    showMessageBox: () => Effect.succeed({ response, checkboxChecked: false }),
    showErrorBox: () => Effect.void,
  } satisfies ElectronDialog.ElectronDialog["Service"]);

const provideDependencies = (
  baseDir: string,
  platform: NodeJS.Platform,
  safeStorageLayer = makeSafeStorageLayer(),
  dialogLayer = makeDialogLayer(),
) =>
  Effect.provide(
    Layer.mergeAll(
      NodeServices.layer,
      makeEnvironmentLayer(baseDir, platform),
      safeStorageLayer,
      dialogLayer,
    ),
  );

describe("DesktopSecretStoreKey", () => {
  it.effect("recognizes an authenticated WSL envelope without offering legacy migration", () =>
    Effect.gen(function* () {
      const key = Uint8Array.from({ length: 32 }, () => 0x5a);
      const name = "oauth";
      const envelope = SecretEnvelope.encodeServerSecretEnvelope(
        name,
        new TextEncoder().encode("refresh-token"),
        key,
      );
      const dialog = Layer.succeed(ElectronDialog.ElectronDialog, {
        pickFolder: () => Effect.die("unexpected dialog"),
        confirm: () => Effect.die("unexpected dialog"),
        showMessageBox: () => Effect.die("authenticated envelopes must not prompt"),
        showErrorBox: () => Effect.die("unexpected dialog"),
      } satisfies ElectronDialog.ElectronDialog["Service"]);

      const fingerprints = yield* DesktopSecretStoreKey.authorizeLegacySecretValues(
        [{ name, value: envelope }],
        [key],
        "WSL distribution Ubuntu",
      ).pipe(Effect.provide(dialog));

      assert.deepEqual(fingerprints, {});
    }),
  );

  it.effect("persists a stable key only as OS-protected ciphertext", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-secret-key-",
      });
      const resolve = DesktopSecretStoreKey.resolve().pipe(provideDependencies(baseDir, "darwin"));

      const first = yield* resolve;
      const second = yield* resolve;
      const wrappedPath = `${baseDir}/userdata/secret-store-key.v1.bin`;
      const wrapped = yield* fileSystem.readFile(wrappedPath);
      const entries = yield* fileSystem.readDirectory(`${baseDir}/userdata`);

      assert.deepEqual(second, first);
      assert.lengthOf(first.keys, 1);
      assert.deepEqual(first.legacySecretFingerprints, {});
      assert.isFalse(Buffer.from(wrapped).includes(Buffer.from(first.keys[0], "utf8")));
      assert.isFalse(entries.some((entry) => entry.endsWith(".tmp")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("migrates approved plaintext and durably consumes its authorization", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-legacy-fingerprint-",
      });
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${baseDir}/userdata/secrets/integration-microsoft-365--oauth.bin`,
        "legacy-value",
      );

      const legacyPath = `${baseDir}/userdata/secrets/integration-microsoft-365--oauth.bin`;
      const material = yield* DesktopSecretStoreKey.resolve().pipe(
        provideDependencies(baseDir, "darwin", makeSafeStorageLayer(), makeDialogLayer(1)),
      );
      const encrypted = yield* fileSystem.readFile(legacyPath);
      const decoded = SecretEnvelope.decodeServerSecretEnvelope(
        "integration-microsoft-365--oauth",
        encrypted,
        [Buffer.from(material.keys[0], "base64")],
      );
      assert.deepEqual(material.legacySecretFingerprints, {});
      assert.equal(new TextDecoder().decode(decoded.value), "legacy-value");

      // Replaying the old bytes does not recreate the one-time migration
      // authorization after it has been removed from the OS-wrapped record.
      yield* fileSystem.writeFileString(legacyPath, "legacy-value");
      const restarted = yield* DesktopSecretStoreKey.resolve().pipe(
        provideDependencies(baseDir, "darwin", makeSafeStorageLayer(), makeDialogLayer(1)),
      );
      assert.deepEqual(restarted.legacySecretFingerprints, {});
      assert.equal(yield* fileSystem.readFileString(legacyPath), "legacy-value");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("migrates legacy plaintext that begins with the envelope magic", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-legacy-magic-",
      });
      const name = "legacy-magic";
      const legacyValue = new TextEncoder().encode("T3SECRET legacy-value");
      const legacyPath = `${baseDir}/userdata/secrets/${name}.bin`;
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
      yield* fileSystem.writeFile(legacyPath, legacyValue);

      const material = yield* DesktopSecretStoreKey.resolve().pipe(
        provideDependencies(baseDir, "darwin", makeSafeStorageLayer(), makeDialogLayer(1)),
      );
      const decoded = SecretEnvelope.decodeServerSecretEnvelope(
        name,
        yield* fileSystem.readFile(legacyPath),
        [Buffer.from(material.keys[0], "base64")],
      );
      assert.deepEqual(Array.from(decoded.value), Array.from(legacyValue));
      assert.deepEqual(material.legacySecretFingerprints, {});
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves legacy files untouched when migration is not explicitly approved", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-declined-migration-",
      });
      const legacyPath = `${baseDir}/userdata/secrets/oauth.bin`;
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
      yield* fileSystem.writeFileString(legacyPath, "legacy-value");

      const error = yield* DesktopSecretStoreKey.resolve().pipe(
        provideDependencies(baseDir, "darwin"),
        Effect.flip,
      );
      assert.instanceOf(error, PlatformError.PlatformError);
      assert.equal(yield* fileSystem.readFileString(legacyPath), "legacy-value");
      assert.isFalse(yield* fileSystem.exists(`${baseDir}/userdata/secret-store-key.v1.bin`));
      assert.isFalse(yield* fileSystem.exists(`${baseDir}/userdata/secret-store.v1.initialized`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when encrypted files remain but the wrapped data key is missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-missing-wrapped-key-",
      });
      const material = yield* DesktopSecretStoreKey.resolve().pipe(
        provideDependencies(baseDir, "darwin"),
      );
      const damagedEnvelope = SecretEnvelope.encodeServerSecretEnvelope(
        "oauth",
        new TextEncoder().encode("refresh-token"),
        Buffer.from(material.keys[0], "base64"),
      );
      damagedEnvelope[0] = (damagedEnvelope[0] ?? 0) ^ 0xff;
      yield* fileSystem.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
      yield* fileSystem.writeFile(`${baseDir}/userdata/secrets/oauth.bin`, damagedEnvelope);
      yield* fileSystem.remove(`${baseDir}/userdata/secret-store-key.v1.bin`);

      const error = yield* DesktopSecretStoreKey.resolve().pipe(
        provideDependencies(baseDir, "darwin"),
        Effect.flip,
      );
      assert.instanceOf(error, PlatformError.PlatformError);
      assert.equal(error.reason._tag, "InvalidData");
      assert.deepEqual(
        Array.from(yield* fileSystem.readFile(`${baseDir}/userdata/secrets/oauth.bin`)),
        Array.from(damagedEnvelope),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not double-encrypt an initialized store when both metadata files are missing",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-missing-secret-metadata-",
        });
        const material = yield* DesktopSecretStoreKey.resolve().pipe(
          provideDependencies(baseDir, "darwin"),
        );
        const envelope = SecretEnvelope.encodeServerSecretEnvelope(
          "oauth",
          new TextEncoder().encode("refresh-token"),
          Buffer.from(material.keys[0], "base64"),
        );
        const secretPath = `${baseDir}/userdata/secrets/oauth.bin`;
        yield* fileSystem.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
        yield* fileSystem.writeFile(secretPath, envelope);
        yield* fileSystem.remove(`${baseDir}/userdata/secret-store-key.v1.bin`);
        yield* fileSystem.remove(`${baseDir}/userdata/secret-store.v1.initialized`);

        const error = yield* DesktopSecretStoreKey.resolve().pipe(
          provideDependencies(baseDir, "darwin", makeSafeStorageLayer(), makeDialogLayer(1)),
          Effect.flip,
        );
        assert.instanceOf(error, PlatformError.PlatformError);
        assert.equal(error.reason._tag, "InvalidData");
        assert.deepEqual(Array.from(yield* fileSystem.readFile(secretPath)), Array.from(envelope));
        assert.isFalse(yield* fileSystem.exists(`${baseDir}/userdata/secret-store-key.v1.bin`));
        assert.isFalse(yield* fileSystem.exists(`${baseDir}/userdata/secret-store.v1.initialized`));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects truncated and unsupported envelope versions during legacy detection", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      for (const variant of ["truncated", "unsupported"] as const) {
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: `t3-desktop-${variant}-secret-envelope-`,
        });
        const material = yield* DesktopSecretStoreKey.resolve().pipe(
          provideDependencies(baseDir, "darwin"),
        );
        const envelope = SecretEnvelope.encodeServerSecretEnvelope(
          "oauth",
          new TextEncoder().encode("refresh-token"),
          Buffer.from(material.keys[0], "base64"),
        );
        const damaged =
          variant === "truncated"
            ? envelope.slice(0, SecretEnvelope.SERVER_SECRET_ENVELOPE_MAGIC.byteLength + 2)
            : Uint8Array.from(envelope);
        if (variant === "unsupported") {
          damaged[SecretEnvelope.SERVER_SECRET_ENVELOPE_MAGIC.byteLength] = 2;
        }
        const secretPath = `${baseDir}/userdata/secrets/oauth.bin`;
        yield* fileSystem.makeDirectory(`${baseDir}/userdata/secrets`, { recursive: true });
        yield* fileSystem.writeFile(secretPath, damaged);
        yield* fileSystem.remove(`${baseDir}/userdata/secret-store-key.v1.bin`);
        yield* fileSystem.remove(`${baseDir}/userdata/secret-store.v1.initialized`);

        const error = yield* DesktopSecretStoreKey.resolve().pipe(
          provideDependencies(baseDir, "darwin", makeSafeStorageLayer(), makeDialogLayer(1)),
          Effect.flip,
        );
        assert.instanceOf(error, PlatformError.PlatformError);
        assert.deepEqual(Array.from(yield* fileSystem.readFile(secretPath)), Array.from(damaged));
        assert.isFalse(yield* fileSystem.exists(`${baseDir}/userdata/secret-store-key.v1.bin`));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects Linux basic_text storage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-linux-secret-key-",
      });
      const error = yield* DesktopSecretStoreKey.resolve().pipe(
        provideDependencies(baseDir, "linux", makeSafeStorageLayer({ backend: "basic_text" })),
        Effect.flip,
      );

      assert.instanceOf(error, PlatformError.PlatformError);
      assert.equal(error.reason._tag, "PermissionDenied");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when OS credential encryption is unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-unavailable-secret-key-",
      });
      const error = yield* DesktopSecretStoreKey.resolve().pipe(
        provideDependencies(baseDir, "win32", makeSafeStorageLayer({ available: false })),
        Effect.flip,
      );

      assert.instanceOf(error, PlatformError.PlatformError);
      assert.equal(error.reason._tag, "PermissionDenied");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "uses DPAPI-backed availability on Windows without consulting Linux backend names",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-windows-secret-key-",
        });
        const material = yield* DesktopSecretStoreKey.resolve().pipe(
          provideDependencies(
            baseDir,
            "win32",
            makeSafeStorageLayer({
              selectedBackendEffect: Effect.die("Linux backend selection must not run on Windows"),
            }),
          ),
        );
        assert.lengthOf(material.keys, 1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
