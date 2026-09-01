import { type IntegrationManifest, validateIntegrationManifest } from "@t3tools/contracts";

export const PLUGIN_SDK_API_MAJOR = 1;
export const PLUGIN_SDK_HOST_CONTRACT_LEVEL = 1;

const API_VERSION = "tritonai.plugin/v1";
const MANIFEST_KEYS = new Set([
  "apiVersion",
  "kind",
  "manifestVersion",
  "id",
  "name",
  "description",
  "version",
  "sdk",
  "entry",
  "provider",
  "configurationSchema",
  "capabilities",
  "tools",
  "skills",
]);
const TOOL_KEYS = new Set([
  "name",
  "displayName",
  "description",
  "capabilities",
  "effect",
  "destructive",
  "idempotent",
  "openWorld",
  "inputSchema",
]);
const MAX_JSON_NODES = 20_000;
const MAX_SCHEMA_BYTES = 128 * 1_024;
const SCHEMA_VALUE_KEYWORDS = [
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const SCHEMA_MAP_KEYWORDS = [
  "$defs",
  "dependentSchemas",
  "patternProperties",
  "properties",
] as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonSchema = JsonObject;

export interface PluginSdkTool {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly effect: "read" | "write";
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly inputSchema: JsonSchema;
}

export interface PluginSdkManifest {
  readonly apiVersion: typeof API_VERSION;
  readonly kind: "IntegrationPlugin";
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly sdk: {
    readonly apiMajor: 1;
    readonly requiredHostContractLevel: number;
  };
  readonly entry: string;
  readonly provider: string;
  readonly configurationSchema: JsonSchema;
  readonly capabilities: IntegrationManifest["capabilities"];
  readonly tools: ReadonlyArray<PluginSdkTool>;
  readonly skills: IntegrationManifest["skills"];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  assert(
    Object.keys(value).every((key) => allowed.has(key)),
    `${label} contains unsupported fields.`,
  );
}

function assertJson(
  value: unknown,
  path = "$",
  depth = 0,
  budget = { nodes: 0 },
  ancestors = new Set<object>(),
): asserts value is JsonValue {
  budget.nodes += 1;
  assert(budget.nodes <= MAX_JSON_NODES, `${path} exceeds the JSON node limit.`);
  assert(depth <= 32, `${path} exceeds the JSON depth limit.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${path} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    assert(value.length <= 1_024, `${path} exceeds the JSON array limit.`);
    assert(!ancestors.has(value), `${path} contains a JSON cycle.`);
    ancestors.add(value);
    assert(
      Reflect.ownKeys(value).length === value.length + 1,
      `${path} must be a dense JSON array.`,
    );
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      assert(
        descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"),
        `${path}[${index}] must be a plain JSON value.`,
      );
      assertJson(descriptor.value, `${path}[${index}]`, depth + 1, budget, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  assert(isRecord(value), `${path} must contain only plain JSON values.`);
  assert(!ancestors.has(value), `${path} contains a JSON cycle.`);
  ancestors.add(value);
  const keys = Object.keys(value);
  assert(
    Reflect.ownKeys(value).length === keys.length,
    `${path} must contain only enumerable string keys.`,
  );
  assert(keys.length <= 1_024, `${path} exceeds the JSON member limit.`);
  for (const key of keys) {
    assert(
      key.length > 0 && key.length <= 256 && key !== "__proto__",
      `${path} has an invalid key.`,
    );
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(
      descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"),
      `${path}.${key} must be a plain JSON value.`,
    );
    assertJson(descriptor.value, `${path}.${key}`, depth + 1, budget, ancestors);
  }
  ancestors.delete(value);
}

export function validateJsonValue(value: unknown, label = "JSON value"): JsonValue {
  assertJson(value, label);
  return value;
}

export function canonicalJson(value: JsonValue): string {
  assertJson(value);
  const normalize = (current: JsonValue): JsonValue => {
    if (Array.isArray(current)) return current.map(normalize);
    if (isRecord(current)) {
      return Object.fromEntries(
        Object.keys(current)
          .sort()
          .map((key) => [key, normalize(current[key] as JsonValue)]),
      );
    }
    return Object.is(current, -0) ? 0 : current;
  };
  return JSON.stringify(normalize(value));
}

function validateSchema(value: unknown, label: string): JsonSchema {
  assertJson(value, label);
  assert(isRecord(value), `${label} must be a JSON Schema object.`);
  const schema = value as JsonSchema;
  assert(
    new TextEncoder().encode(canonicalJson(schema)).byteLength <= MAX_SCHEMA_BYTES,
    `${label} exceeds the schema byte limit.`,
  );
  assert(
    schema.$schema === "https://json-schema.org/draft/2020-12/schema",
    `${label} must declare JSON Schema draft 2020-12.`,
  );
  assert(schema.type === "object", `${label} must describe an object.`);
  assert(schema.additionalProperties === false, `${label} must reject undeclared root fields.`);
  assert(isRecord(schema.properties), `${label} must declare root properties.`);

  const resolveReference = (reference: string, path: string): JsonValue => {
    let pointer: string;
    try {
      pointer = decodeURIComponent(reference.slice(1));
    } catch {
      throw new Error(`${path} must be a local fragment JSON Pointer.`);
    }
    assert(
      reference.startsWith("#") && /^(?:\/(?:[^~/]|~[01])*)*$/u.test(pointer),
      `${path} must be a local fragment JSON Pointer.`,
    );
    let target: JsonValue = schema;
    const tokens = pointer.length === 0 ? [] : pointer.slice(1).split("/");
    for (const part of tokens) {
      const token = part.replaceAll("~1", "/").replaceAll("~0", "~");
      if (Array.isArray(target)) {
        assert(/^(?:0|[1-9]\d*)$/u.test(token), `${path} does not resolve.`);
        const index = Number(token);
        assert(index < target.length, `${path} does not resolve.`);
        target = target[index]!;
      } else {
        assert(isRecord(target) && Object.hasOwn(target, token), `${path} does not resolve.`);
        target = target[token] as JsonValue;
      }
    }
    assert(isRecord(target) || typeof target === "boolean", `${path} must resolve to a schema.`);
    return target;
  };

  const isSchemaValue = (candidate: unknown): candidate is JsonObject | boolean =>
    typeof candidate === "boolean" || isRecord(candidate);
  const visitSubschemas = (
    current: JsonObject,
    path: string,
    visit: (subschema: JsonObject | boolean, path: string) => void,
  ): void => {
    for (const keyword of SCHEMA_VALUE_KEYWORDS) {
      const subschema = current[keyword];
      if (subschema === undefined) continue;
      assert(isSchemaValue(subschema), `${path}.${keyword} must be a schema.`);
      visit(subschema, `${path}.${keyword}`);
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      const subschemas = current[keyword];
      if (subschemas === undefined) continue;
      assert(Array.isArray(subschemas), `${path}.${keyword} must be a schema array.`);
      subschemas.forEach((subschema, index) => {
        assert(isSchemaValue(subschema), `${path}.${keyword}[${index}] must be a schema.`);
        visit(subschema, `${path}.${keyword}[${index}]`);
      });
    }
    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const subschemas = current[keyword];
      if (subschemas === undefined) continue;
      assert(isRecord(subschemas), `${path}.${keyword} must be a schema map.`);
      for (const [name, subschema] of Object.entries(subschemas)) {
        assert(isSchemaValue(subschema), `${path}.${keyword}.${name} must be a schema.`);
        visit(subschema, `${path}.${keyword}.${name}`);
      }
    }
  };

  const inspected = new Set<object>();
  const inspect = (current: JsonValue, path: string): void => {
    if (!isRecord(current)) return;
    if (inspected.has(current)) return;
    inspected.add(current);
    for (const keyword of [
      "$anchor",
      "$dynamicAnchor",
      "$dynamicRef",
      "$id",
      "$recursiveAnchor",
      "$recursiveRef",
      "$vocabulary",
    ]) {
      assert(current[keyword] === undefined, `${path} may not use ${keyword}.`);
    }
    if (current.pattern !== undefined) {
      assert(
        typeof current.pattern === "string" && current.pattern.length <= 256,
        `${path}.pattern is invalid.`,
      );
      try {
        RegExp(current.pattern, "u");
      } catch {
        throw new Error(`${path}.pattern is invalid.`);
      }
    }
    if (current.patternProperties !== undefined) {
      assert(isRecord(current.patternProperties), `${path}.patternProperties must be an object.`);
      for (const pattern of Object.keys(current.patternProperties)) {
        assert(pattern.length <= 256, `${path}.patternProperties contains an excessive pattern.`);
        try {
          RegExp(pattern, "u");
        } catch {
          throw new Error(`${path}.patternProperties contains an invalid pattern.`);
        }
      }
    }
    if (current.$ref !== undefined) {
      assert(typeof current.$ref === "string", `${path} has an invalid $ref.`);
      inspect(resolveReference(current.$ref, `${path}.$ref`), `${path}.$ref target`);
    }
    visitSubschemas(current as JsonObject, path, inspect);
  };
  inspect(schema, label);

  const visiting = new Set<object>();
  const visited = new Set<object>();
  const assertAcyclic = (target: JsonValue, name: string): void => {
    if (typeof target === "boolean" || !isRecord(target) || visited.has(target)) return;
    assert(!visiting.has(target), `${label} contains a recursive reference graph at ${name}.`);
    visiting.add(target);
    const nested = new Set<string>();
    const collect = (current: JsonValue): void => {
      if (!isRecord(current)) return;
      if (typeof current.$ref === "string") nested.add(current.$ref);
      visitSubschemas(current as JsonObject, label, collect);
    };
    collect(target);
    nested.forEach((reference) =>
      assertAcyclic(resolveReference(reference, `${label} reference ${reference}`), reference),
    );
    visiting.delete(target);
    visited.add(target);
  };
  assertAcyclic(schema, "#");
  return schema;
}

export function validatePluginSdkManifest(value: unknown): {
  readonly sdkManifest: PluginSdkManifest;
  readonly manifest: IntegrationManifest;
} {
  assert(isRecord(value), "Plugin SDK manifest must be an object.");
  assertOnlyKeys(value, MANIFEST_KEYS, "Plugin SDK manifest");
  assert(
    value.apiVersion === API_VERSION &&
      value.kind === "IntegrationPlugin" &&
      value.manifestVersion === 1,
    "Plugin SDK manifest API, kind, or version is unsupported.",
  );
  assert(isRecord(value.sdk), "Plugin SDK compatibility must be an object.");
  assertOnlyKeys(
    value.sdk,
    new Set(["apiMajor", "requiredHostContractLevel"]),
    "Plugin SDK compatibility",
  );
  assert(value.sdk.apiMajor === PLUGIN_SDK_API_MAJOR, "Plugin SDK API major is unsupported.");
  assert(
    Number.isSafeInteger(value.sdk.requiredHostContractLevel) &&
      (value.sdk.requiredHostContractLevel as number) > 0,
    "Plugin SDK host contract level is invalid.",
  );
  assert(
    typeof value.entry === "string" && /^dist\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/u.test(value.entry),
    "Plugin SDK entry is invalid.",
  );
  assert(typeof value.provider === "string", "Plugin SDK provider is required.");
  assert(Array.isArray(value.tools), "Plugin SDK tools must be an array.");
  const tools = value.tools.map((tool, index): PluginSdkTool => {
    assert(isRecord(tool), `Plugin SDK tool ${index} must be an object.`);
    assertOnlyKeys(tool, TOOL_KEYS, `Plugin SDK tool ${index}`);
    for (const annotation of ["destructive", "idempotent", "openWorld"]) {
      assert(
        typeof tool[annotation] === "boolean",
        `Plugin SDK tool ${index} ${annotation} is required.`,
      );
    }
    return {
      ...(tool as unknown as Omit<PluginSdkTool, "inputSchema">),
      inputSchema: validateSchema(
        tool.inputSchema,
        `Plugin SDK tool ${String(tool.name)} inputSchema`,
      ),
    };
  });
  const configurationSchema = validateSchema(
    value.configurationSchema,
    "Plugin SDK configurationSchema",
  );
  const registryManifest = validateIntegrationManifest({
    apiVersion: "tritonai.harness/v2",
    kind: "IntegrationPlugin",
    manifestVersion: 2,
    id: value.id,
    name: value.name,
    description: value.description,
    version: value.version,
    provider: value.provider,
    capabilities: value.capabilities,
    tools: tools.map(
      ({
        inputSchema: _inputSchema,
        destructive: _destructive,
        idempotent: _idempotent,
        openWorld: _openWorld,
        ...tool
      }) => tool,
    ),
    skills: value.skills,
  });
  const sdkManifest = {
    ...value,
    configurationSchema,
    capabilities: registryManifest.capabilities,
    tools,
    skills: registryManifest.skills,
  } as unknown as PluginSdkManifest;
  assertJson(sdkManifest);
  return { sdkManifest, manifest: registryManifest };
}
