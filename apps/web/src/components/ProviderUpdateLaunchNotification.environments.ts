import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import type { ProviderDriverKind } from "@t3tools/contracts";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useEnvironmentProviders,
} from "~/state/environments";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import {
  buildLocalEnvironmentUpdateGroups,
  deriveEnvironmentDisplayLabel,
  type EnvironmentUpdateConnectionState,
  type LocalEnvironmentProvidersInput,
  type LocalEnvironmentUpdateGroup,
} from "./ProviderUpdateLaunchNotification.logic";

function isLocalConnectionTarget(target: ConnectionCatalogEntry["target"]): boolean {
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);
}

function normalizeConnectionState(phase: string | undefined): EnvironmentUpdateConnectionState {
  switch (phase) {
    case "connected":
      return "ready";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "unsupported":
    case "error":
      return "error";
    case "offline":
      return "disconnected";
    default:
      return "connecting";
  }
}

/**
 * Reactively enumerate the enabled local environments (the primary plus any
 * desktop-local secondary such as WSL) with each one's full provider list and a
 * flag for whether any is still connecting. Drives the launch popover's gating
 * and its per-environment update triggers.
 */
export function useLocalEnvironmentUpdateGroups(providerDriver?: ProviderDriverKind): {
  readonly groups: LocalEnvironmentUpdateGroup[];
  readonly isAnySettling: boolean;
} {
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const inputs: LocalEnvironmentProvidersInput[] = [];

  for (const environment of environments) {
    if (!isLocalConnectionTarget(environment.entry.target)) {
      continue;
    }

    const isPrimary = environment.environmentId === primaryEnvironmentId;
    const serverConfig = environment.serverConfig;

    inputs.push({
      environmentId: environment.environmentId,
      label: isPrimary
        ? deriveEnvironmentDisplayLabel({
            isWsl: false,
            wslDistro: null,
            platformOs: serverConfig?.environment.platform.os,
            fallbackLabel: environment.label,
          })
        : environment.label,
      isPrimary,
      connectionState: isPrimary ? "ready" : normalizeConnectionState(environment.connection.phase),
      providers: providersByEnvironment.get(environment.environmentId) ?? [],
    });
  }

  inputs.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));

  return buildLocalEnvironmentUpdateGroups(inputs, providerDriver);
}
