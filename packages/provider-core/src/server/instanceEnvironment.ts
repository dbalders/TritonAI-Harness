import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

const CODEX_NETWORK_SANDBOX_MARKER_NAME = "CODEX_SANDBOX_NETWORK_DISABLED";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform?: NodeJS.Platform,
) {
  if (!environment || environment.length === 0) return baseEnv;
  const home = yield* HostProcess.HomeDirectory;
  const effectivePlatform = platform ?? (yield* HostProcess.Platform);
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    if (effectivePlatform === "win32") {
      const normalizedName = variable.name.toLowerCase();
      for (const existingName of Object.keys(next)) {
        if (existingName !== variable.name && existingName.toLowerCase() === normalizedName) {
          delete next[existingName];
        }
      }
    }
    const normalizedName =
      effectivePlatform === "win32" ? variable.name.toUpperCase() : variable.name;
    next[variable.name] =
      normalizedName === "CODEX_HOME" || normalizedName === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});

/** Do not inherit the outer Codex shell's network restriction into a new app-server. */
export function withoutInheritedCodexNetworkSandboxMarker(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const name of Object.keys(next)) {
    const normalizedName = platform === "win32" ? name.toUpperCase() : name;
    if (normalizedName === CODEX_NETWORK_SANDBOX_MARKER_NAME) delete next[name];
  }
  return next;
}
