import {
  TRITONAI_FRONTIER_PROVIDER_INSTANCE_ID,
  TRITONAI_ONPREM_PROVIDER_INSTANCE_ID,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { CloudyIcon, ServerIcon, type LucideIcon } from "lucide-react";

/**
 * Distinguish TritonAI's managed routes without changing the generic icon and
 * badge treatment used by upstream and personal provider instances.
 */
export function getTritonAiManagedRouteIcon(
  instanceId: ProviderInstanceId,
  displayName: string,
): LucideIcon | null {
  const normalizedDisplayName = displayName.trim().toLowerCase();

  if (
    String(instanceId) === TRITONAI_ONPREM_PROVIDER_INSTANCE_ID &&
    normalizedDisplayName === "on-prem models"
  ) {
    return ServerIcon;
  }

  if (
    String(instanceId) === TRITONAI_FRONTIER_PROVIDER_INSTANCE_ID &&
    normalizedDisplayName === "frontier models"
  ) {
    return CloudyIcon;
  }

  return null;
}
