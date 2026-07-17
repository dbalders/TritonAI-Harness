import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

const CODEX_NETWORK_SANDBOX_MARKER_NAME = "CODEX_SANDBOX_NETWORK_DISABLED";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform?: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    if (platform === "win32") {
      const normalizedName = variable.name.toLowerCase();
      for (const existingName of Object.keys(next)) {
        if (existingName !== variable.name && existingName.toLowerCase() === normalizedName) {
          delete next[existingName];
        }
      }
    }
    next[variable.name] = variable.value;
  }
  return next;
}

/**
 * Codex injects this marker into shell commands whose current sandbox disables networking.
 * A parent value passed into the nested app-server would make full-access turns report a stale
 * restriction instead of letting the inner Codex runtime describe its own sandbox policy.
 */
export function withoutInheritedCodexNetworkSandboxMarker(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const name of Object.keys(next)) {
    const normalizedName = platform === "win32" ? name.toUpperCase() : name;
    if (normalizedName === CODEX_NETWORK_SANDBOX_MARKER_NAME) {
      delete next[name];
    }
  }
  return next;
}
