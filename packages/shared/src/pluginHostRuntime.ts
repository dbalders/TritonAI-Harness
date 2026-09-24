export const EFFECT_HOST_PEER_RANGE = ">=4.0.0-beta.78 <4.0.0";

const MINIMUM_EFFECT_BETA = 78;
const LEGACY_EFFECT_BUILD_VERSION = "4.0.0-beta.78";
const EFFECT_PRERELEASE_VERSION = /^4\.0\.0-(beta|rc)\.(0|[1-9]\d*)$/u;

export interface PluginPackageRuntimeMetadata {
  readonly dependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly bundledDependencies?: unknown;
  readonly bundleDependencies?: unknown;
}

export interface PluginHostRuntimeDependency {
  readonly name: "effect";
  readonly version: string;
  readonly declaration: "legacy-dependency" | "peer";
}

function dependencyRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Managed plugin ${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function isSupportedEffectHostVersion(version: string): boolean {
  const match = EFFECT_PRERELEASE_VERSION.exec(version);
  if (!match) return false;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) && (match[1] === "rc" || revision >= MINIMUM_EFFECT_BETA);
}

/**
 * Resolves the single Harness-owned runtime admitted across the managed-plugin boundary.
 *
 * The first released v2 plugin used one exact `dependencies.effect` build pin. New packages use
 * the canonical peer range. Both execute against the one Effect instance supplied by Harness.
 * The legacy carve-out is intentionally exact; arbitrary prerelease pins are not a compatibility
 * promise.
 */
export function resolvePluginHostRuntimeDependencies(
  packageJson: PluginPackageRuntimeMetadata,
  hostEffectVersion: string,
): ReadonlyArray<PluginHostRuntimeDependency> {
  if (!isSupportedEffectHostVersion(hostEffectVersion)) {
    throw new Error(
      `Harness Effect ${hostEffectVersion} is outside the managed plugin host-runtime contract.`,
    );
  }
  const optionalDependencies = dependencyRecord(
    packageJson.optionalDependencies,
    "optionalDependencies",
  );
  if (Object.keys(optionalDependencies).length > 0) {
    throw new Error("Managed plugins cannot declare optional runtime dependencies.");
  }
  const bundledDependencies = [
    packageJson.bundledDependencies,
    packageJson.bundleDependencies,
  ].filter((value) => value !== undefined);
  if (bundledDependencies.some((value) => !Array.isArray(value) || value.length > 0)) {
    throw new Error("Managed plugins cannot bundle runtime dependencies.");
  }

  const dependencies = dependencyRecord(packageJson.dependencies, "dependencies");
  const peerDependencies = dependencyRecord(packageJson.peerDependencies, "peerDependencies");
  const dependencyNames = Object.keys(dependencies).sort();
  const peerNames = Object.keys(peerDependencies).sort();

  if (dependencyNames.length === 1 && dependencyNames[0] === "effect" && peerNames.length === 0) {
    if (dependencies.effect !== LEGACY_EFFECT_BUILD_VERSION) {
      throw new Error(
        `Managed plugin Effect build ${String(dependencies.effect)} is not compatible with Harness Effect ${hostEffectVersion}.`,
      );
    }
    return [{ name: "effect", version: hostEffectVersion, declaration: "legacy-dependency" }];
  }

  if (
    dependencyNames.length === 0 &&
    peerNames.length === 1 &&
    peerNames[0] === "effect" &&
    peerDependencies.effect === EFFECT_HOST_PEER_RANGE
  ) {
    return [{ name: "effect", version: hostEffectVersion, declaration: "peer" }];
  }

  throw new Error(
    `Managed plugin runtime dependencies must be either the released ${LEGACY_EFFECT_BUILD_VERSION} build pin or the canonical ${EFFECT_HOST_PEER_RANGE} peer contract.`,
  );
}
