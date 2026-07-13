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
  readonly provider: string;
  readonly capabilities: ReadonlyArray<IntegrationManifestCapability>;
  readonly tools: ReadonlyArray<IntegrationManifestTool>;
  readonly skills: ReadonlyArray<IntegrationManifestSkill>;
}

const ID = /^[a-z][a-z0-9.-]*$/u;
const TOOL = /^[a-z][a-z0-9_.-]*$/u;
const SKILL = /^[a-z][a-z0-9-]{0,63}$/u;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Integration manifest must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (input.apiVersion !== HARNESS_INTEGRATION_API_VERSION) {
    throw new Error(`Unsupported integration apiVersion ${String(input.apiVersion)}.`);
  }
  if (input.kind !== "IntegrationPlugin" || input.manifestVersion !== 1) {
    throw new Error("Integration manifest kind or manifestVersion is unsupported.");
  }
  for (const field of ["id", "name", "description", "version", "provider"] as const) {
    if (!nonEmpty(input[field])) throw new Error(`Integration manifest ${field} is required.`);
  }
  if (!ID.test(input.id as string) || !ID.test(input.provider as string)) {
    throw new Error("Integration and provider identifiers must use lowercase stable slugs.");
  }
  if (!parsedVersion(input.version as string))
    throw new Error("Integration version must be semver.");
  const compatibility = input.compatibility as IntegrationManifest["compatibility"] | undefined;
  if (
    !compatibility?.harness ||
    !nonEmpty(compatibility.harness.min) ||
    !nonEmpty(compatibility.harness.maxExclusive) ||
    !parsedVersion(compatibility.harness.min) ||
    !parsedVersion(compatibility.harness.maxExclusive)
  ) {
    throw new Error("Integration manifest must declare an explicit Harness version range.");
  }
  if (compareVersion(compatibility.harness.min, compatibility.harness.maxExclusive) >= 0) {
    throw new Error("Integration Harness version range must have min < maxExclusive.");
  }
  const capabilities = input.capabilities;
  const tools = input.tools;
  const skills = input.skills;
  if (!Array.isArray(capabilities) || !Array.isArray(tools) || !Array.isArray(skills)) {
    throw new Error("Integration capabilities, tools, and skills must be arrays.");
  }
  const capabilityIds = new Set<string>();
  for (const capability of capabilities) {
    if (!capability || typeof capability !== "object") throw new Error("Invalid capability.");
    const item = capability as Record<string, unknown>;
    if (
      !nonEmpty(item.id) ||
      !ID.test(item.id) ||
      !nonEmpty(item.displayName) ||
      !nonEmpty(item.description)
    ) {
      throw new Error("Every capability requires a unique id, displayName, and description.");
    }
    if (capabilityIds.has(item.id)) throw new Error(`Duplicate capability ${item.id}.`);
    capabilityIds.add(item.id);
  }
  const names = new Set<string>();
  for (const [kind, entries] of [
    ["tool", tools],
    ["skill", skills],
  ] as const) {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw new Error(`Invalid ${kind}.`);
      const item = entry as Record<string, unknown>;
      const namePattern = kind === "skill" ? SKILL : TOOL;
      if (!nonEmpty(item.name) || !namePattern.test(item.name) || !nonEmpty(item.description)) {
        throw new Error(`Every ${kind} requires a stable name and description.`);
      }
      if (kind === "tool" && !nonEmpty(item.displayName)) {
        throw new Error("Every tool requires a displayName.");
      }
      if (!nonEmpty(item.capability) || !capabilityIds.has(item.capability)) {
        throw new Error(`${kind} ${item.name} references an unknown capability.`);
      }
      if (names.has(item.name)) throw new Error(`Duplicate component name ${item.name}.`);
      names.add(item.name);
    }
  }
  return value as IntegrationManifest;
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
