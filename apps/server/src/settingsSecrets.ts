import {
  AntigravitySettings,
  ClaudeSettings,
  CloudSpeechCredentials,
  CodexSettings,
  EasDeviceHostConfig,
  type ProviderInstanceConfig,
  type ServerSettings,
  type SettingsSecretValue,
  SimlockDeviceHostConfig,
  TextGeneratorConfig,
  UsageLimitSourceConfig,
  isSecretSetting,
  isSecretReference,
  secretSettingsFields,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { kiroClient } from "@t3tools/provider-kiro/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";
import {
  readSecretFieldValues,
  SOURCE_CONTROL_HOST_SECRET_FIELDS,
  sourceControlHostSecretName,
  writeSecretFieldValues,
} from "./sourceControl/sourceControlHostSecrets.ts";

export const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

const providerSettingsSchemas = new Map<string, Parameters<typeof secretSettingsFields>[0]>([
  ["codex", CodexSettings],
  ["claudeAgent", ClaudeSettings],
  ["antigravity", AntigravitySettings],
  ...[
    cursorClient,
    grokClient,
    kiroClient,
    museClient,
    openCodeClient,
    piClient,
    acpRegistryClient,
  ].map((definition) => [definition.driverKind, definition.settingsSchema] as const),
]);
const providerSecretFields = new Map(
  [...providerSettingsSchemas].map(([driver, schema]) => [driver, secretSettingsFields(schema)]),
);

/** Support views use each field's schema to strip undeclared children at every depth. */
export function knownProviderSettingsFields(
  driver: string,
): Parameters<typeof secretSettingsFields>[0]["fields"] | undefined {
  return providerSettingsSchemas.get(driver)?.fields;
}

function inspectableSettingsShape(ast: SchemaAST.AST, nested = false): boolean {
  // The secret mapper handles top-level schema secrets. Nested declarations have
  // no mapped presence marker, so omit their containing field instead of exposing it.
  if (nested && isSecretSetting(Schema.make(ast))) return false;
  const inspect = (child: SchemaAST.AST) => inspectableSettingsShape(child, true);
  switch (ast._tag) {
    case "Arrays":
      return ast.elements.every(inspect) && ast.rest.every(inspect);
    case "Objects":
      return (
        ast.propertySignatures.length + ast.indexSignatures.length > 0 &&
        ast.propertySignatures.every((property) => inspect(property.type)) &&
        ast.indexSignatures.every((index) => inspect(index.type))
      );
    case "Union":
      return ast.types.every(inspect);
    case "String":
    case "Number":
    case "Boolean":
    case "Null":
    case "Undefined":
    case "Literal":
    case "Enum":
    case "TemplateLiteral":
      return true;
    default:
      // Unknown/Any, unconstrained objects and declarations are opaque to support.
      return false;
  }
}

/** Project an already-redacted setting through its schema without defaults or normalization. */
export function settingsFieldForSupport(
  schema: Schema.Top,
  value: unknown,
): Option.Option<unknown> {
  const encoded = Schema.toEncoded(schema);
  if (
    !inspectableSettingsShape(Schema.toType(schema).ast) ||
    !inspectableSettingsShape(encoded.ast)
  )
    return Option.none();
  return Schema.decodeUnknownOption(encoded, { onExcessProperty: "ignore" })(value);
}
const usageLimitSecretFields = secretSettingsFields(UsageLimitSourceConfig);
const textGeneratorSecretFields = secretSettingsFields(TextGeneratorConfig);
const voiceSecretFields = secretSettingsFields(CloudSpeechCredentials);
const easDeviceHostSecretFields = secretSettingsFields(EasDeviceHostConfig);
const simlockDeviceHostSecretFields = secretSettingsFields(SimlockDeviceHostConfig);
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

export interface SettingsSecret {
  readonly secretName: string;
  readonly kind: "field" | "environment";
  readonly value: string;
  readonly redacted: boolean;
  readonly sensitive: boolean;
  readonly providerInstanceId?: string;
  readonly environmentVariable?: string;
}

type SecretValue = Pick<SettingsSecret, "value" | "redacted">;
type SecretSlotName = (field: string, serverHost: string | null) => string;
type SecretFieldsMapper = (
  fields: Readonly<Record<string, unknown>>,
  secretFields: ReadonlyArray<string>,
  name: SecretSlotName,
) => Record<string, unknown>;
type ProviderEnvironment = NonNullable<ProviderInstanceConfig["environment"]>;

export function mapSettingsSecrets(
  settings: ServerSettings,
  map: (secret: SettingsSecret) => SecretValue,
): ServerSettings {
  const mapFields: SecretFieldsMapper = (fields, secretFields, name) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next) || isSecretReference(next[field])) continue;
      next[field] = writeSecretFieldValues(
        next[field],
        readSecretFieldValues(next[field]).map(([serverHost, value]) => {
          const result = map({
            secretName: name(field, serverHost),
            kind: "field",
            value,
            redacted: value === SECRET_REDACTED,
            sensitive: true,
          });
          return [serverHost, result.redacted ? SECRET_REDACTED : result.value] as const;
        }),
      );
    }
    return next;
  };

  return mapSecretFieldGroups(settings, mapFields, (instanceId, environment) =>
    environment.map((variable) => {
      const { valueRedacted: _omit, ...rest } = variable;
      // A secret reference is not itself secret; storage sees the value cleared.
      const reference = typeof variable.value === "string" ? undefined : variable.value;
      const result = map({
        secretName: `provider-env-${encode(instanceId)}-${encode(variable.name)}`,
        kind: "environment",
        value: typeof variable.value === "string" ? variable.value : "",
        redacted: reference === undefined && variable.valueRedacted === true,
        sensitive: variable.sensitive,
        providerInstanceId: instanceId,
        environmentVariable: variable.name,
      });
      if (reference !== undefined) return { ...rest, value: reference };
      return {
        ...rest,
        value: result.value,
        ...(result.redacted ? { valueRedacted: true } : {}),
      };
    }),
  );
}

/**
 * Maps each value a secret field holds, literal or reference, with the secret name of its slot.
 * Provider environment variables are left as they are.
 */
export function mapSettingsSecretValues(
  settings: ServerSettings,
  map: (value: SettingsSecretValue, secretName: string) => SettingsSecretValue,
): ServerSettings {
  const mapValue = (value: unknown, secretName: string) =>
    typeof value === "string" || isSecretReference(value) ? map(value, secretName) : value;
  return mapSecretFieldGroups(settings, (fields, secretFields, name) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next)) continue;
      const value = next[field];
      next[field] =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !isSecretReference(value)
          ? Object.fromEntries(
              Object.entries(value).map(([serverHost, entry]) => [
                serverHost,
                mapValue(entry, name(field, serverHost.trim().toLowerCase())),
              ]),
            )
          : mapValue(value, name(field, null));
    }
    return next;
  });
}

function mapSecretFieldGroups(
  settings: ServerSettings,
  mapFields: SecretFieldsMapper,
  mapEnvironment: (instanceId: string, environment: ProviderEnvironment) => ProviderEnvironment = (
    _instanceId,
    environment,
  ) => environment,
): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const config = instance.config;
      return [
        instanceId,
        {
          ...instance,
          ...(config !== null && typeof config === "object" && !Array.isArray(config)
            ? {
                config: mapFields(
                  config as Record<string, unknown>,
                  providerSecretFields.get(instance.driver) ?? [],
                  (field, serverHost) =>
                    `provider-config-${encode(instanceId)}-${encode(instance.driver)}-${encode(field)}` +
                    (serverHost === null ? "" : `-${encode(serverHost)}`),
                ),
              }
            : {}),
          ...(instance.environment
            ? { environment: mapEnvironment(instanceId, instance.environment) }
            : {}),
        },
      ];
    }),
  );

  const sourceControlHosts = Object.fromEntries(
    Object.entries(settings.sourceControlHosts).map(([kind, fields]) => [
      kind,
      mapFields(fields, SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? [], (field, serverHost) =>
        sourceControlHostSecretName({ kind, field, serverHost }),
      ),
    ]),
  ) as ServerSettings["sourceControlHosts"];

  const usageLimitSources = Object.fromEntries(
    Object.entries(settings.usageLimitSources).map(([id, source]) => [
      id,
      mapFields(
        source,
        usageLimitSecretFields,
        (field, serverHost) =>
          `usage-limit-source-${encode(id)}` +
          (field === "managementKey" && serverHost === null
            ? ""
            : `-${encode(field)}${serverHost === null ? "" : `-${encode(serverHost)}`}`),
      ),
    ]),
  ) as ServerSettings["usageLimitSources"];

  const textGenerators = Object.fromEntries(
    Object.entries(settings.textGenerators).map(([id, generator]) => [
      id,
      mapFields(
        generator,
        textGeneratorSecretFields,
        (field, serverHost) =>
          `text-generator-${encode(id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ),
    ]),
  ) as ServerSettings["textGenerators"];

  const easDeviceHosts = settings.easDeviceHosts.map(
    (host) =>
      mapFields(
        host,
        easDeviceHostSecretFields,
        (field, serverHost) =>
          `device-host-${encode(host.id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ) as EasDeviceHostConfig,
  );

  // Its own prefix: an EAS and a Simlock host may share an id.
  const simlockDeviceHosts = settings.simlockDeviceHosts.map(
    (host) =>
      mapFields(
        host,
        simlockDeviceHostSecretFields,
        (field, serverHost) =>
          `simlock-device-host-${encode(host.id)}-${encode(field)}` +
          (serverHost === null ? "" : `-${encode(serverHost)}`),
      ) as SimlockDeviceHostConfig,
  );

  return {
    ...settings,
    cloudSpeechCredentials: mapFields(
      settings.cloudSpeechCredentials,
      voiceSecretFields,
      (provider) => `voice-cloud-${provider}`,
    ) as ServerSettings["cloudSpeechCredentials"],
    providerInstances,
    sourceControlHosts,
    usageLimitSources,
    textGenerators,
    easDeviceHosts,
    simlockDeviceHosts,
  };
}

/**
 * `next` with every secret reference to a secret provider that `current` has and `next` dropped
 * unset: a credential field becomes empty, and a provider variable holding one is removed.
 */
export function withoutRemovedSecretProviderReferences(
  current: ServerSettings,
  next: ServerSettings,
): ServerSettings {
  const removed = new Set(
    Object.keys(current.secretProviders).filter((id) => !Object.hasOwn(next.secretProviders, id)),
  );
  if (removed.size === 0) return next;
  const isRemoved = (value: unknown) => isSecretReference(value) && removed.has(value.provider);
  const fields = mapSettingsSecretValues(next, (value) => (isRemoved(value) ? "" : value));
  return {
    ...fields,
    providerInstances: Object.fromEntries(
      Object.entries(fields.providerInstances).map(([instanceId, instance]) => [
        instanceId,
        instance.environment?.some((variable) => isRemoved(variable.value))
          ? {
              ...instance,
              environment: instance.environment.filter((variable) => !isRemoved(variable.value)),
            }
          : instance,
      ]),
    ),
  };
}
