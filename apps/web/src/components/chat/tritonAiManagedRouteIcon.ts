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
export function getTritonAiManagedRouteIcon(instanceId: ProviderInstanceId): LucideIcon | null {
  if (String(instanceId) === TRITONAI_ONPREM_PROVIDER_INSTANCE_ID) {
    return ServerIcon;
  }

  if (String(instanceId) === TRITONAI_FRONTIER_PROVIDER_INSTANCE_ID) {
    return CloudyIcon;
  }

  return null;
}
