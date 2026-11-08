import {
  type ProviderInstanceEnvironment,
  TRITONAI_API_KEY_ENV,
  TRITONAI_API_KEY_SOURCE_ENV,
  TRITONAI_FRONTIER_API_KEY_ENV,
  TRITONAI_FRONTIER_PROVIDER_INSTANCE_ID,
  TRITONAI_ONPREM_API_KEY_ENV,
  TRITONAI_ONPREM_PROVIDER_INSTANCE_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  mergeProviderInstanceEnvironment,
  withoutInheritedCodexNetworkSandboxMarker,
} from "@t3tools/provider-core/server/instanceEnvironment";

export const mergeCodexProviderEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  instanceId: string,
) {
  const requestedSourceName = environment?.find(
    (variable) => variable.name.toUpperCase() === TRITONAI_API_KEY_SOURCE_ENV,
  )?.value;
  const credentialEnvironmentNames = new Set(
    [
      TRITONAI_API_KEY_ENV,
      TRITONAI_API_KEY_SOURCE_ENV,
      TRITONAI_ONPREM_API_KEY_ENV,
      TRITONAI_FRONTIER_API_KEY_ENV,
    ].map((name) => name.toUpperCase()),
  );
  const expectedSourceName =
    instanceId === TRITONAI_ONPREM_PROVIDER_INSTANCE_ID
      ? TRITONAI_ONPREM_API_KEY_ENV
      : instanceId === TRITONAI_FRONTIER_PROVIDER_INSTANCE_ID
        ? TRITONAI_FRONTIER_API_KEY_ENV
        : undefined;
  const sourceName = requestedSourceName?.trim();
  const isManagedRoute = expectedSourceName !== undefined && sourceName === expectedSourceName;
  // Process-level TritonAI credentials are Installer-managed in this
  // distribution. A personal Codex instance can opt in only by configuring
  // its own key explicitly; it must never inherit a managed shared or route key.
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(withoutInheritedCodexNetworkSandboxMarker(baseEnv, platform)).filter(
      ([name]) => !credentialEnvironmentNames.has(name.toUpperCase()),
    ),
  );
  const merged = yield* mergeProviderInstanceEnvironment(
    environment?.filter((variable) =>
      isManagedRoute
        ? !credentialEnvironmentNames.has(variable.name.toUpperCase())
        : variable.name.toUpperCase() !== TRITONAI_API_KEY_SOURCE_ENV,
    ),
    inheritedEnvironment,
    platform,
  );
  const environmentValue = (name: string | undefined): string | undefined => {
    if (!name) return undefined;
    const entry = Object.entries(baseEnv).find(([candidate]) =>
      platform === "win32" ? candidate.toUpperCase() === name.toUpperCase() : candidate === name,
    );
    const value = entry?.[1]?.trim();
    return value && value.length > 0 ? value : undefined;
  };
  const managedTritonAiApiKey = isManagedRoute
    ? (environmentValue(TRITONAI_API_KEY_ENV) ?? environmentValue(expectedSourceName))
    : undefined;
  if (!managedTritonAiApiKey) return merged;

  // A shared desktop replacement remains authoritative. Otherwise the managed
  // route selects one backend credential and exposes only that value to this
  // Codex child process.
  return yield* mergeProviderInstanceEnvironment(
    [
      {
        name: TRITONAI_API_KEY_ENV,
        value: managedTritonAiApiKey,
        sensitive: true,
      },
    ],
    merged,
    platform,
  );
});
