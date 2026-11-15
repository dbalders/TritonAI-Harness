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
  const windows = (platform ?? (yield* HostProcess.Platform)) === "win32";
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    // Windows reads names without regard to case, and a child gets the first spelling in sort
    // order. Upper case sorts first, so the configured value wins even where a spawn merges the
    // parent environment back in.
    const name = windows ? variable.name.toUpperCase() : variable.name;
    if (windows) {
      for (const inherited of Object.keys(next)) {
        if (inherited.toUpperCase() === name) delete next[inherited];
      }
    }
    next[name] =
      name === "CODEX_HOME" || name === "CLAUDE_CONFIG_DIR"
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
