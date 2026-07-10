import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

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
