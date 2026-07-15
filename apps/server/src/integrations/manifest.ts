import packageJson from "../../package.json" with { type: "json" };

export const HARNESS_INTEGRATION_API_VERSION = "tritonai.harness/v1" as const;
export const HARNESS_VERSION = packageJson.version;

export interface IntegrationManifestCapability {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}

export interface IntegrationManifestTool {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly capability: string;
}

export interface IntegrationManifestSkill {
  readonly name: string;
  readonly description: string;
  readonly capability: string;
}

export interface IntegrationManifest {
  readonly apiVersion: typeof HARNESS_INTEGRATION_API_VERSION;
  readonly kind: "IntegrationPlugin";
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly compatibility: {
    readonly harness: {
      readonly min: string;
      readonly maxExclusive: string;
    };
  };
  readonly provider?: string;
  readonly capabilities: ReadonlyArray<IntegrationManifestCapability>;
  readonly tools: ReadonlyArray<IntegrationManifestTool>;
  readonly skills: ReadonlyArray<IntegrationManifestSkill>;
}

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const MAX_ID_LENGTH = 64;
const TOOL = /^[a-z][a-z0-9_.-]*$/u;
const MAX_TOOL_NAME_LENGTH = 128;
const SKILL = /^[a-z][a-z0-9-]{0,63}$/u;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MANIFEST_KEYS = new Set([
  "apiVersion",
  "kind",
  "manifestVersion",
  "id",
  "name",
  "description",
  "version",
  "compatibility",
  "provider",
  "capabilities",
  "tools",
  "skills",
]);
const COMPATIBILITY_KEYS = new Set(["harness"]);
const HARNESS_COMPATIBILITY_KEYS = new Set(["min", "maxExclusive"]);
const CAPABILITY_KEYS = new Set(["id", "displayName", "description"]);
const TOOL_KEYS = new Set(["name", "displayName", "description", "capability"]);
const SKILL_KEYS = new Set(["name", "description", "capability"]);

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

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareVersion(left: string, right: string): number {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  if (!a || !b) throw new Error(`Invalid semantic version: ${!a ? left : right}`);
  for (const key of ["major", "minor", "patch"] as const) {
    const compared = compareNumericIdentifier(a[key], b[key]);
    if (compared) return compared;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const identifiers = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
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
  if (input.kind !== "IntegrationPlugin" || input.manifestVersion !== 1) {
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
  const compatibility = input.compatibility;
  if (!isRecord(compatibility)) {
    throw new Error("Integration manifest must declare an explicit Harness version range.");
  }
  if (!hasOnlyKeys(compatibility, COMPATIBILITY_KEYS)) {
    throw new Error("Integration compatibility contains unsupported fields.");
  }
  const harness = compatibility.harness;
  if (!isRecord(harness)) {
    throw new Error("Integration manifest must declare an explicit Harness version range.");
  }
  if (!hasOnlyKeys(harness, HARNESS_COMPATIBILITY_KEYS)) {
    throw new Error("Integration Harness compatibility contains unsupported fields.");
  }
  if (
    !nonEmpty(harness.min) ||
    !nonEmpty(harness.maxExclusive) ||
    !isIntegrationVersion(harness.min) ||
    !isIntegrationVersion(harness.maxExclusive)
  ) {
    throw new Error("Integration manifest must declare an explicit Harness version range.");
  }
  if (compareVersion(harness.min, harness.maxExclusive) >= 0) {
    throw new Error("Integration Harness version range must have min < maxExclusive.");
  }
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
      !nonEmpty(item.description)
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
      if (!nonEmpty(item.capability) || !capabilityIds.has(item.capability)) {
        throw new Error(`${kind} ${item.name} references an unknown capability.`);
      }
      if (names.has(name)) throw new Error(`Duplicate ${kind} name ${name}.`);
      names.add(name);
    }
  }
  return input as unknown as IntegrationManifest;
}

export function manifestCompatibility(manifest: IntegrationManifest): {
  readonly compatible: boolean;
  readonly message: string | null;
} {
  const { min, maxExclusive } = manifest.compatibility.harness;
  const compatible =
    compareVersion(HARNESS_VERSION, min) >= 0 && compareVersion(HARNESS_VERSION, maxExclusive) < 0;
  return {
    compatible,
    message: compatible
      ? null
      : `Requires TritonAI Harness >=${min} and <${maxExclusive}; this server is ${HARNESS_VERSION}.`,
  };
}
