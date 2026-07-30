export const EFFECT_HOST_PEER_RANGE = ">=4.0.0-beta.78 <4.0.0";

const MINIMUM_EFFECT_BETA = 78;
const EFFECT_BETA_VERSION = /^4\.0\.0-beta\.(\d+)$/u;

export interface PluginPackageRuntimeMetadata {
  readonly dependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly bundledDependencies?: unknown;
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

function effectBetaNumber(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const match = EFFECT_BETA_VERSION.exec(version);
  if (!match?.[1]) return null;
  const beta = Number(match[1]);
  return Number.isSafeInteger(beta) ? beta : null;
}

/**
 * Resolves the single Harness-owned runtime admitted across the managed-plugin boundary.
 *
 * Released v2 plugins used an exact `dependencies.effect` build pin. New packages use the
 * canonical peer range. Both execute against the one Effect instance supplied by Harness, and
 * only forward beta updates on the reviewed Effect 4.0 beta line are admitted.
 */
export function resolvePluginHostRuntimeDependencies(
  packageJson: PluginPackageRuntimeMetadata,
  hostEffectVersion: string,
): ReadonlyArray<PluginHostRuntimeDependency> {
  const hostBeta = effectBetaNumber(hostEffectVersion);
  if (hostBeta === null || hostBeta < MINIMUM_EFFECT_BETA) {
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
  if (
    packageJson.bundledDependencies !== undefined &&
    (!Array.isArray(packageJson.bundledDependencies) || packageJson.bundledDependencies.length > 0)
  ) {
    throw new Error("Managed plugins cannot bundle runtime dependencies.");
  }

  const dependencies = dependencyRecord(packageJson.dependencies, "dependencies");
  const peerDependencies = dependencyRecord(packageJson.peerDependencies, "peerDependencies");
  const dependencyNames = Object.keys(dependencies).toSorted();
  const peerNames = Object.keys(peerDependencies).toSorted();

  if (dependencyNames.length === 1 && dependencyNames[0] === "effect" && peerNames.length === 0) {
    const compiledBeta = effectBetaNumber(dependencies.effect);
    if (compiledBeta === null || compiledBeta < MINIMUM_EFFECT_BETA || compiledBeta > hostBeta) {
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
    `Managed plugin runtime dependencies must be either the released Effect 4 beta build pin or the canonical ${EFFECT_HOST_PEER_RANGE} peer contract.`,
  );
}
