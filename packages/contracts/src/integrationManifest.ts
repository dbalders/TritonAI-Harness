export const HARNESS_INTEGRATION_API_VERSION = "tritonai.harness/v2" as const;

export interface IntegrationManifestCapability {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly access: "default" | "opt-in";
}

export interface IntegrationManifestTool {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly effect: "read" | "write";
}

export interface IntegrationManifestSkill {
  readonly name: string;
  readonly description: string;
  readonly capabilities: ReadonlyArray<string>;
}

export interface IntegrationManifest {
  readonly apiVersion: typeof HARNESS_INTEGRATION_API_VERSION;
  readonly kind: "IntegrationPlugin";
  readonly manifestVersion: 2;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly provider?: string;
  readonly capabilities: ReadonlyArray<IntegrationManifestCapability>;
  readonly tools: ReadonlyArray<IntegrationManifestTool>;
  readonly skills: ReadonlyArray<IntegrationManifestSkill>;
}

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*(?![\s\S])/u;
const MAX_ID_LENGTH = 64;
const TOOL = /^[a-z][a-z0-9_.-]*(?![\s\S])/u;
const MAX_TOOL_NAME_LENGTH = 128;
const SKILL = /^[a-z][a-z0-9-]{0,63}(?![\s\S])/u;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?![\s\S])/u;
const MANIFEST_KEYS = new Set([
  "apiVersion",
  "kind",
  "manifestVersion",
  "id",
  "name",
  "description",
  "version",
  "provider",
  "capabilities",
  "tools",
  "skills",
]);
const CAPABILITY_KEYS = new Set(["id", "displayName", "description", "access"]);
const TOOL_KEYS = new Set(["name", "displayName", "description", "capabilities", "effect"]);
const SKILL_KEYS = new Set(["name", "description", "capabilities"]);

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

interface ParsedVersion {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: ReadonlyArray<string>;
}

function parsedVersion(value: string): ParsedVersion | null {
  const match = VERSION.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/u.test(identifier) && /^0\d+/u.test(identifier))) {
    return null;
  }
  return {
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
  };
}

export function isIntegrationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && ID.test(value);
}

export function isIntegrationSkillName(value: unknown): value is string {
  return typeof value === "string" && SKILL.test(value);
}

export function isIntegrationVersion(value: unknown): value is string {
  return typeof value === "string" && parsedVersion(value) !== null;
}

export function validateIntegrationManifest(value: unknown): IntegrationManifest {
  if (!isRecord(value)) {
    throw new Error("Integration manifest must be an object.");
  }
  const input = value;
  if (!hasOnlyKeys(input, MANIFEST_KEYS)) {
    throw new Error("Integration manifest contains unsupported fields.");
  }
  if (input.apiVersion !== HARNESS_INTEGRATION_API_VERSION) {
    throw new Error(`Unsupported integration apiVersion ${String(input.apiVersion)}.`);
  }
  if (input.kind !== "IntegrationPlugin" || input.manifestVersion !== 2) {
    throw new Error("Integration manifest kind or manifestVersion is unsupported.");
  }
  for (const field of ["id", "name", "description", "version"] as const) {
    if (!nonEmpty(input[field])) throw new Error(`Integration manifest ${field} is required.`);
  }
  if (!isIntegrationId(input.id)) {
    throw new Error("Integration identifiers must use lowercase stable slugs.");
  }
  if (input.provider !== undefined && !isIntegrationId(input.provider)) {
    throw new Error("Integration provider identifiers must use lowercase stable slugs.");
  }
  if (!isIntegrationVersion(input.version)) throw new Error("Integration version must be semver.");
  const capabilities = input.capabilities;
  const tools = input.tools;
  const skills = input.skills;
  if (!Array.isArray(capabilities) || !Array.isArray(tools) || !Array.isArray(skills)) {
    throw new Error("Integration capabilities, tools, and skills must be arrays.");
  }
  if (tools.length > 0 && input.provider === undefined) {
    throw new Error("Integration plugins with tools must declare a provider.");
  }
  const capabilityIds = new Set<string>();
  for (const capability of capabilities) {
    if (!isRecord(capability) || !hasOnlyKeys(capability, CAPABILITY_KEYS)) {
      throw new Error("Invalid or unsupported capability fields.");
    }
    const item = capability;
    if (
      !nonEmpty(item.id) ||
      !isIntegrationId(item.id) ||
      !nonEmpty(item.displayName) ||
      !nonEmpty(item.description) ||
      (item.access !== "default" && item.access !== "opt-in")
    ) {
      throw new Error("Every capability requires a unique id, displayName, and description.");
    }
    if (capabilityIds.has(item.id)) throw new Error(`Duplicate capability ${item.id}.`);
    capabilityIds.add(item.id);
  }
  for (const [kind, entries] of [
    ["tool", tools],
    ["skill", skills],
  ] as const) {
    const names = new Set<string>();
    for (const entry of entries) {
      const allowed = kind === "tool" ? TOOL_KEYS : SKILL_KEYS;
      if (!isRecord(entry) || !hasOnlyKeys(entry, allowed)) {
        throw new Error(`Invalid or unsupported ${kind} fields.`);
      }
      const item = entry;
      if (
        typeof item.name !== "string" ||
        (kind === "skill"
          ? !isIntegrationSkillName(item.name)
          : item.name.length > MAX_TOOL_NAME_LENGTH || !TOOL.test(item.name)) ||
        !nonEmpty(item.description)
      ) {
        throw new Error(`Every ${kind} requires a stable name and description.`);
      }
      const name = item.name;
      if (kind === "tool" && !nonEmpty(item.displayName)) {
        throw new Error("Every tool requires a displayName.");
      }
      const references = item.capabilities;
      if (
        !Array.isArray(references) ||
        references.length === 0 ||
        references.some((capability) => !nonEmpty(capability) || !capabilityIds.has(capability)) ||
        new Set(references).size !== references.length
      ) {
        throw new Error(`${kind} ${item.name} references an unknown capability.`);
      }
      if (kind === "tool" && item.effect !== "read" && item.effect !== "write") {
        throw new Error(`Tool ${item.name} has an invalid effect.`);
      }
      if (names.has(name)) throw new Error(`Duplicate ${kind} name ${name}.`);
      names.add(name);
    }
  }
  return {
    ...(input as unknown as Omit<IntegrationManifest, "capabilities" | "tools" | "skills">),
    capabilities: capabilities.map((capability) => ({
      id: capability.id as string,
      displayName: capability.displayName as string,
      description: capability.description as string,
      access: capability.access as "default" | "opt-in",
    })),
    tools: tools.map((tool) => ({
      name: tool.name as string,
      displayName: tool.displayName as string,
      description: tool.description as string,
      capabilities: tool.capabilities as ReadonlyArray<string>,
      effect: tool.effect as "read" | "write",
    })),
    skills: skills.map((skill) => ({
      name: skill.name as string,
      description: skill.description as string,
      capabilities: skill.capabilities as ReadonlyArray<string>,
    })),
  };
}
