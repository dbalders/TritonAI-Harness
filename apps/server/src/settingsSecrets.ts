import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  EasDeviceHostConfig,
  type ServerSettings,
  UsageLimitSourceConfig,
  isSecretSetting,
  secretSettingsFields,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
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
  ...[cursorClient, grokClient, museClient, openCodeClient, piClient, acpRegistryClient].map(
    (definition) => [definition.driverKind, definition.settingsSchema] as const,
  ),
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
const easDeviceHostSecretFields = secretSettingsFields(EasDeviceHostConfig);
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

export function mapSettingsSecrets(
  settings: ServerSettings,
  map: (secret: SettingsSecret) => SecretValue,
): ServerSettings {
  const mapFields = (
    fields: Readonly<Record<string, unknown>>,
    secretFields: ReadonlyArray<string>,
    name: (field: string, serverHost: string | null) => string,
  ) => {
    const next = { ...fields };
    for (const field of secretFields) {
      if (!(field in next)) continue;
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
            ? {
                environment: instance.environment.map((variable) => {
                  const result = map({
                    secretName: `provider-env-${encode(instanceId)}-${encode(variable.name)}`,
                    kind: "environment",
                    value: variable.value,
                    redacted: variable.valueRedacted === true,
                    sensitive: variable.sensitive,
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                  });
                  const { valueRedacted: _omit, ...rest } = variable;
                  return {
                    ...rest,
                    value: result.value,
                    ...(result.redacted ? { valueRedacted: true } : {}),
                  };
                }),
              }
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

  return { ...settings, providerInstances, sourceControlHosts, usageLimitSources, easDeviceHosts };
}
