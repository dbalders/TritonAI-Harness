/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  TRITONAI_API_KEY_ENV,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  applyServerSettingsPatch,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import {
  applyManagedHarnessPolicy,
  migrateLegacyInstallerManagedSettings,
  rawSettingsHasTextGenerationSelection,
  stripManagedFieldsForPersistence,
} from "./managedPolicy.ts";

export { resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeUnknownJsonPretty = Schema.encodeUnknownEffect(fromJsonStringPretty(Schema.Unknown));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodeServerSettingsExit = Schema.decodeUnknownExit(ServerSettings);
const decodeUnknownJsonExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function collectUnknownSettingsFields(
  raw: unknown,
  known: unknown,
  replacedRootKeys?: ReadonlySet<string>,
): unknown | undefined {
  const rawRecord = jsonRecord(raw);
  const knownRecord = jsonRecord(known);
  if (!rawRecord || !knownRecord) return undefined;
  const preserved: JsonRecord = {};
  for (const [key, value] of Object.entries(rawRecord)) {
    if (replacedRootKeys?.has(key)) continue;
    if (!Object.hasOwn(knownRecord, key)) {
      preserved[key] = value;
      continue;
    }
    const nested = collectUnknownSettingsFields(value, knownRecord[key]);
    if (nested !== undefined) preserved[key] = nested;
  }
  return Object.keys(preserved).length > 0 ? preserved : undefined;
}

function mergeJsonDocuments(base: unknown, overlay: unknown): unknown {
  const baseRecord = jsonRecord(base);
  const overlayRecord = jsonRecord(overlay);
  if (!baseRecord || !overlayRecord) return overlay;
  const merged: JsonRecord = { ...baseRecord };
  for (const [key, value] of Object.entries(overlayRecord)) {
    merged[key] = Object.hasOwn(merged, key) ? mergeJsonDocuments(merged[key], value) : value;
  }
  return merged;
}

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

const LEGACY_OPENCODE_SERVER_CREDENTIAL_KEY = "provider-legacy-opencode-server-credential";

function removeManagedTritonAiProviderEnvironment(settings: ServerSettings): ServerSettings {
  let changed = false;
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      if (!instance.environment) return [instanceId, instance];
      const environment = instance.environment.filter(
        (variable) => variable.name.toUpperCase() !== TRITONAI_API_KEY_ENV,
      );
      if (environment.length === instance.environment.length) return [instanceId, instance];
      changed = true;
      return [instanceId, { ...instance, environment }];
    }),
  );
  return changed ? { ...settings, providerInstances } : settings;
}

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (!variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      instance.environment
        ? {
            ...instance,
            environment: instance.environment.map(redactProviderEnvironmentVariable),
          }
        : instance,
    ]),
  );
  return { ...settings, providerInstances };
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    /** Start the settings runtime and attach file watching. */
    readonly start: Effect.Effect<void, ServerSettingsError>;

    /** Await settings runtime readiness. */
    readonly ready: Effect.Effect<void, ServerSettingsError>;

    /** Read the current settings. */
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Read the normalized user-owned settings before the managed policy overlay. */
    readonly getPersistedSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Patch settings and persist. Returns the new full settings object. */
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Stream of settings change events. */
    readonly streamChanges: Stream.Stream<ServerSettings>;

    /**
     * Acquire a settings change subscription synchronously in the current
     * fiber. Use this before reading a snapshot when changes between the
     * snapshot and a lazily started stream must not be lost.
     */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("t3/serverSettings/ServerSettingsService") {
  /** @deprecated Import and use `layerTest` from this module. */
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Effect.gen(function* () {
    const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
      overrides;
    const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
    const initialSettings = yield* normalizeServerSettings({
      ...merged,
      ...(automaticGitFetchInterval !== undefined
        ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
        : {}),
      ...(providerHealthRefreshInterval !== undefined
        ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
        : {}),
    });
    const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider)),
      getPersistedSettings: Ref.get(currentSettingsRef),
      updateSettings: (patch) =>
        Ref.get(currentSettingsRef).pipe(
          Effect.map((currentSettings) => applyServerSettingsPatch(currentSettings, patch)),
          Effect.flatMap(normalizeServerSettings),
          Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
          Effect.map(resolveTextGenerationProvider),
        ),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    } satisfies ServerSettingsService["Service"];
  });

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

const LegacyOpenCodePasswordJson = fromLenientJson(
  Schema.Struct({
    providers: Schema.optionalKey(
      Schema.Struct({
        opencode: Schema.optionalKey(
          Schema.Struct({
            serverPassword: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  }),
);
const decodeLegacyOpenCodePasswordJsonExit = Schema.decodeUnknownExit(LegacyOpenCodePasswordJson);

function hasExplicitLegacyOpenCodePasswordClear(raw: string): boolean {
  const decoded = decodeLegacyOpenCodePasswordJsonExit(raw);
  if (decoded._tag === "Failure") return false;
  const opencode = decoded.value.providers?.opencode;
  return (
    opencode !== undefined &&
    Object.hasOwn(opencode, "serverPassword") &&
    opencode.serverPassword?.trim().length === 0
  );
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const fallbackEntry = Object.entries(settings.providers).find(([, provider]) => provider.enabled);
  const fallback = fallbackEntry ? ProviderDriverKind.make(fallbackEntry[0]) : undefined;
  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make(fallback),
      model:
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "textGenerationModelSelection",
]);

// Preserve both enabled states because provider history cannot recover a new opt-in.
const PERSISTED_SERVER_SETTINGS_DEFAULTS = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: undefined },
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: undefined },
    opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: undefined },
  },
};

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const make = (
  managedPolicyEnabled: boolean,
  credentialEnvironment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const { settingsPath } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const writeSemaphore = yield* Semaphore.make(1);
    const cacheKey = "settings" as const;
    const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
    const rawDocumentRef = yield* Ref.make<unknown>({});
    const startedRef = yield* Ref.make(false);
    const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
    const watcherScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

    const emitChange = (settings: ServerSettings) =>
      PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

    const applyEffectivePolicy = (settings: ServerSettings) =>
      managedPolicyEnabled
        ? Ref.get(rawDocumentRef).pipe(
            Effect.map((rawDocument) =>
              applyManagedHarnessPolicy(settings, undefined, {
                textGenerationSelectionWasPersisted:
                  rawSettingsHasTextGenerationSelection(rawDocument),
                credentialEnvironment,
              }),
            ),
          )
        : Effect.succeed(settings);

    const readConfigExists = fs.exists(settingsPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "check-exists",
            cause,
          }),
      ),
    );

    const readRawConfig = fs.readFileString(settingsPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-file",
            cause,
          }),
      ),
    );

    const materializeProviderSecrets = (
      settings: ServerSettings,
    ): Effect.Effect<ServerSettings, ServerSettingsError> =>
      Effect.gen(function* () {
        const providerInstances: Record<string, ProviderInstanceConfig> = {
          ...settings.providerInstances,
        };
        for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
          if (!instance.environment) continue;
          const environment: ProviderInstanceEnvironmentVariable[] = [];
          for (const variable of instance.environment) {
            if (!variable.sensitive || !variable.valueRedacted) {
              environment.push(variable);
              continue;
            }
            const secret = yield* secretStore
              .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "read-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
            environment.push({
              ...variable,
              value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
            });
          }
          providerInstances[instanceId] = {
            ...instance,
            environment,
          } satisfies ProviderInstanceConfig;
        }

        const storedValue = yield* secretStore.get(LEGACY_OPENCODE_SERVER_CREDENTIAL_KEY).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: "opencode",
                environmentVariable: "serverPassword",
                cause,
              }),
          ),
        );
        const currentPassword = Option.isSome(storedValue)
          ? textDecoder.decode(storedValue.value)
          : settings.providers.opencode.serverPassword;
        return {
          ...settings,
          providers: {
            ...settings.providers,
            opencode: {
              ...settings.providers.opencode,
              serverPassword: currentPassword,
            },
          },
          providerInstances: providerInstances as ServerSettings["providerInstances"],
        };
      });

    const removeLegacyOpenCodeStoredValue = secretStore
      .remove(LEGACY_OPENCODE_SERVER_CREDENTIAL_KEY)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              operation: "remove-secret",
              providerInstanceId: "opencode",
              environmentVariable: "serverPassword",
              cause,
            }),
        ),
      );

    interface SecretDescriptor {
      readonly name: string;
      readonly providerInstanceId: string;
      readonly environmentVariable: string;
    }

    const secretDescriptorsForUpdate = (
      current: ServerSettings,
      next: ServerSettings,
    ): ReadonlyArray<SecretDescriptor> => {
      const descriptors = new Map<string, SecretDescriptor>();
      descriptors.set(LEGACY_OPENCODE_SERVER_CREDENTIAL_KEY, {
        name: LEGACY_OPENCODE_SERVER_CREDENTIAL_KEY,
        providerInstanceId: "opencode",
        environmentVariable: "serverPassword",
      });
      for (const settings of [current, next]) {
        for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
          for (const variable of instance.environment ?? []) {
            const name = providerEnvironmentSecretName({ instanceId, name: variable.name });
            if (descriptors.has(name)) continue;
            descriptors.set(name, {
              name,
              providerInstanceId: instanceId,
              environmentVariable: variable.name,
            });
          }
        }
      }
      return Array.from(descriptors.values());
    };

    const snapshotProviderSecrets = (
      current: ServerSettings,
      next: ServerSettings,
    ): Effect.Effect<
      ReadonlyArray<readonly [SecretDescriptor, Option.Option<Uint8Array>]>,
      ServerSettingsError
    > =>
      Effect.forEach(secretDescriptorsForUpdate(current, next), (descriptor) =>
        secretStore.get(descriptor.name).pipe(
          Effect.map((value) => [descriptor, value] as const),
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: descriptor.providerInstanceId,
                environmentVariable: descriptor.environmentVariable,
                cause,
              }),
          ),
        ),
      );

    const restoreProviderSecrets = (
      snapshot: ReadonlyArray<readonly [SecretDescriptor, Option.Option<Uint8Array>]>,
    ): Effect.Effect<void> =>
      Effect.forEach(
        snapshot,
        ([descriptor, previousValue]) =>
          Option.match(previousValue, {
            onNone: () => secretStore.remove(descriptor.name),
            onSome: (value) => secretStore.set(descriptor.name, value),
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("failed to restore provider credential", {
                settingsPath,
                providerInstanceId: descriptor.providerInstanceId,
                environmentVariable: descriptor.environmentVariable,
                cause,
              }),
            ),
          ),
        { discard: true },
      );

    const runWithProviderSecretRollback = <A>(
      current: ServerSettings,
      next: ServerSettings,
      effect: Effect.Effect<A, ServerSettingsError>,
    ): Effect.Effect<A, ServerSettingsError> =>
      Effect.gen(function* () {
        const snapshot = yield* snapshotProviderSecrets(current, next);
        return yield* effect.pipe(
          Effect.catchCause((cause) =>
            restoreProviderSecrets(snapshot).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      });

    const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
      changes.pipe(
        Stream.mapEffect((settings) =>
          materializeProviderSecrets(settings).pipe(
            Effect.catch((error: ServerSettingsError) =>
              Effect.logWarning("failed to materialize provider environment secrets", {
                operation: error.operation,
                providerInstanceId: error.providerInstanceId,
                environmentVariable: error.environmentVariable,
                cause: error.cause,
              }).pipe(Effect.as(settings)),
            ),
          ),
        ),
        Stream.mapEffect(applyEffectivePolicy),
        Stream.map(resolveTextGenerationProvider),
      );

    const persistProviderSecrets = (
      current: ServerSettings,
      next: ServerSettings,
    ): Effect.Effect<ServerSettings, ServerSettingsError> =>
      Effect.gen(function* () {
        const providerInstances: Record<string, ProviderInstanceConfig> = {
          ...next.providerInstances,
        };

        const nextSecretKeys = new Set<string>();
        for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
          if (!instance.environment) continue;
          const environment: ProviderInstanceEnvironmentVariable[] = [];
          for (const variable of instance.environment) {
            const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
            if (!variable.sensitive) {
              yield* secretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              environment.push(redactProviderEnvironmentVariable(variable));
              continue;
            }

            nextSecretKeys.add(secretName);
            if (!variable.valueRedacted) {
              if (variable.value.length > 0) {
                yield* secretStore.set(secretName, textEncoder.encode(variable.value)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerSettingsError({
                        settingsPath,
                        operation: "write-secret",
                        providerInstanceId: instanceId,
                        environmentVariable: variable.name,
                        cause,
                      }),
                  ),
                );
                environment.push({ ...variable, value: "", valueRedacted: true });
              } else {
                yield* secretStore.remove(secretName).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerSettingsError({
                        settingsPath,
                        operation: "remove-secret",
                        providerInstanceId: instanceId,
                        environmentVariable: variable.name,
                        cause,
                      }),
                  ),
                );
                const { valueRedacted: _omit, ...rest } = variable;
                environment.push(rest);
              }
              continue;
            }

            environment.push(redactProviderEnvironmentVariable(variable));
          }
          providerInstances[instanceId] = {
            ...instance,
            environment,
          } satisfies ProviderInstanceConfig;
        }

        for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
          for (const variable of instance.environment ?? []) {
            if (!variable.sensitive) continue;
            const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
            if (nextSecretKeys.has(secretName)) continue;
            yield* secretStore.remove(secretName).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "remove-stale-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
          }
        }

        // OpenCodeSettings defines this field as TrimmedString, and persistence runs before
        // normalizeServerSettings, so normalize it before writing the secret-store value.
        const storedValue = next.providers.opencode.serverPassword.trim();
        if (storedValue.length > 0) {
          yield* secretStore
            .set(LEGACY_OPENCODE_SERVER_CREDENTIAL_KEY, textEncoder.encode(storedValue))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "write-secret",
                    providerInstanceId: "opencode",
                    environmentVariable: "serverPassword",
                    cause,
                  }),
              ),
            );
        } else if (current.providers.opencode.serverPassword.length > 0) {
          yield* removeLegacyOpenCodeStoredValue;
        }

        return {
          ...next,
          providers: {
            ...next.providers,
            opencode: {
              ...next.providers.opencode,
              serverPassword: "",
            },
          },
          providerInstances: providerInstances as ServerSettings["providerInstances"],
        };
      });

    const writeSettingsAtomically = Effect.fnUntraced(
      function* (
        settings: ServerSettings,
        options?: { readonly replaceProviderInstances?: boolean },
      ) {
        const [encodedSettings, encodedDefaults, rawDocument] = yield* Effect.all([
          encodeServerSettings(settings),
          encodeServerSettings(DEFAULT_SERVER_SETTINGS),
          Ref.get(rawDocumentRef),
        ]);
        const sparseSettings = stripDefaultServerSettings(encodedSettings, encodedDefaults) ?? {};
        const unknownSettings =
          collectUnknownSettingsFields(
            rawDocument,
            encodedSettings,
            options?.replaceProviderInstances ? new Set(["providerInstances"]) : undefined,
          ) ?? {};
        const persistedDocument = mergeJsonDocuments(unknownSettings, sparseSettings);
        const sparseSettingsJson = yield* encodeUnknownJsonPretty(persistedDocument);

        yield* writeFileStringAtomically({
          filePath: settingsPath,
          contents: `${sparseSettingsJson}\n`,
          mode: 0o600,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
        );
        yield* Ref.set(rawDocumentRef, persistedDocument);
      },
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "write-file",
            cause,
          }),
      ),
    );

    const hasPlaintextProviderSecret = (settings: ServerSettings): boolean =>
      settings.providers.opencode.serverPassword.length > 0 ||
      Object.values(settings.providerInstances).some((instance) =>
        instance.environment?.some(
          (variable) => variable.sensitive && !variable.valueRedacted && variable.value.length > 0,
        ),
      );

    const loadSettingsFromDisk = Effect.gen(function* () {
      if (!(yield* readConfigExists)) {
        yield* Ref.set(rawDocumentRef, {});
        return DEFAULT_SERVER_SETTINGS;
      }

      const raw = yield* readRawConfig;
      const parsed = decodeUnknownJsonExit(raw);
      if (parsed._tag === "Failure") {
        yield* Effect.logWarning("failed to parse settings.json, using defaults", {
          path: settingsPath,
          issues: Cause.pretty(parsed.cause),
          cause: parsed.cause,
        });
        yield* Ref.set(rawDocumentRef, {});
        return DEFAULT_SERVER_SETTINGS;
      }
      const migration = managedPolicyEnabled
        ? migrateLegacyInstallerManagedSettings(parsed.value)
        : { document: parsed.value, migrated: false };
      yield* Ref.set(rawDocumentRef, migration.document);
      const decoded = decodeServerSettingsExit(migration.document);
      if (decoded._tag === "Failure") {
        yield* Effect.logWarning("failed to parse settings.json, using defaults", {
          path: settingsPath,
          issues: Cause.pretty(decoded.cause),
          cause: decoded.cause,
        });
        return DEFAULT_SERVER_SETTINGS;
      }
      const withoutManagedTritonAiProviderEnvironment = removeManagedTritonAiProviderEnvironment(
        decoded.value,
      );
      const removedManagedTritonAiProviderEnvironment =
        withoutManagedTritonAiProviderEnvironment !== decoded.value;
      if (hasExplicitLegacyOpenCodePasswordClear(raw)) {
        return yield* runWithProviderSecretRollback(
          decoded.value,
          withoutManagedTritonAiProviderEnvironment,
          removeLegacyOpenCodeStoredValue.pipe(
            Effect.andThen(
              persistProviderSecrets(decoded.value, withoutManagedTritonAiProviderEnvironment),
            ),
            Effect.flatMap(normalizeServerSettings),
            Effect.tap(writeSettingsAtomically),
          ),
        );
      }
      if (
        !hasPlaintextProviderSecret(decoded.value) &&
        !removedManagedTritonAiProviderEnvironment
      ) {
        if (migration.migrated) {
          yield* writeSettingsAtomically(withoutManagedTritonAiProviderEnvironment);
        }
        return decoded.value;
      }

      const migrated = yield* runWithProviderSecretRollback(
        decoded.value,
        withoutManagedTritonAiProviderEnvironment,
        persistProviderSecrets(decoded.value, withoutManagedTritonAiProviderEnvironment).pipe(
          Effect.flatMap(normalizeServerSettings),
          Effect.tap(writeSettingsAtomically),
        ),
      );
      return migrated;
    });

    const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
      capacity: 1,
      lookup: () => loadSettingsFromDisk,
    });

    const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

    const revalidateAndEmit = writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* Cache.invalidate(settingsCache, cacheKey);
        const settings = yield* getSettingsFromCache;
        const materialized = yield* materializeProviderSecrets(settings);
        yield* emitChange(yield* applyEffectivePolicy(materialized));
      }),
    );

    const startWatcher = Effect.gen(function* () {
      const settingsDir = pathService.dirname(settingsPath);
      const settingsFile = pathService.basename(settingsPath);
      const settingsPathResolved = pathService.resolve(settingsPath);

      yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              operation: "prepare-directory",
              cause,
            }),
        ),
      );

      const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

      // Debounce watch events so the file is fully written before we read it.
      // Editors emit multiple events per save (truncate, write, rename) and
      // `fs.watch` can fire before the content has been flushed to disk.
      const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
        Stream.filter((event) => {
          return (
            event.path === settingsFile ||
            event.path === settingsPath ||
            pathService.resolve(settingsDir, event.path) === settingsPathResolved
          );
        }),
        Stream.debounce(Duration.millis(100)),
      );

      yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(watcherScope),
        Effect.asVoid,
      );
    });

    const start = Effect.gen(function* () {
      const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
      if (!shouldStart) {
        return yield* Deferred.await(startedDeferred);
      }

      const startup = Effect.gen(function* () {
        yield* startWatcher;
        yield* writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            yield* Cache.invalidate(settingsCache, cacheKey);
            yield* getSettingsFromCache;
          }),
        );
      });

      const startupExit = yield* Effect.exit(startup);
      if (startupExit._tag === "Failure") {
        yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
        return yield* Effect.failCause(startupExit.cause);
      }

      yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
    });

    return {
      start,
      ready: Deferred.await(startedDeferred),
      getSettings: getSettingsFromCache.pipe(
        Effect.flatMap(materializeProviderSecrets),
        Effect.flatMap(applyEffectivePolicy),
        Effect.map(resolveTextGenerationProvider),
      ),
      getPersistedSettings: getSettingsFromCache.pipe(Effect.flatMap(materializeProviderSecrets)),
      updateSettings: (patch) =>
        writeSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* getSettingsFromCache.pipe(
              Effect.flatMap(materializeProviderSecrets),
            );
            const patched = applyServerSettingsPatch(current, patch);
            const proposed = removeManagedTritonAiProviderEnvironment(
              managedPolicyEnabled ? stripManagedFieldsForPersistence(patched) : patched,
            );
            const next = yield* runWithProviderSecretRollback(
              current,
              proposed,
              persistProviderSecrets(current, proposed).pipe(
                Effect.flatMap(normalizeServerSettings),
                Effect.tap((settings) =>
                  writeSettingsAtomically(settings, {
                    replaceProviderInstances: patch.providerInstances !== undefined,
                  }),
                ),
              ),
            );
            yield* Cache.set(settingsCache, cacheKey, next);
            const materialized = yield* materializeProviderSecrets(next);
            const effective = yield* applyEffectivePolicy(materialized);
            yield* emitChange(effective);
            return resolveTextGenerationProvider(effective);
          }),
        ),
      get streamChanges() {
        return materializeChanges(Stream.fromPubSub(changesPubSub));
      },
      get subscribeChanges() {
        return PubSub.subscribe(changesPubSub).pipe(
          Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
        );
      },
    } satisfies ServerSettingsService["Service"];
  });

export const layer = Layer.effect(ServerSettingsService, make(true));

/** Managed policy layer with an explicit credential snapshot for deterministic tests. */
export const layerManagedTest = (credentialEnvironment: NodeJS.ProcessEnv) =>
  Layer.effect(ServerSettingsService, make(true, credentialEnvironment));

/** Parent-compatible settings behavior for tests that do not exercise the TritonAI overlay. */
export const layerUnmanagedTest = Layer.effect(ServerSettingsService, make(false));
