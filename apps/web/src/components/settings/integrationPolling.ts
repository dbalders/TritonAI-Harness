import type { IntegrationDeviceCodeConnectResult } from "@t3tools/contracts";

export type ScheduledIntegrationFlow = IntegrationDeviceCodeConnectResult & {
  readonly nextPollAtMilliseconds: number;
};

export function scheduleIntegrationFlow(
  flow: IntegrationDeviceCodeConnectResult,
  nowMilliseconds = Date.now(),
): ScheduledIntegrationFlow {
  const expiresAtMilliseconds = Date.parse(flow.expiresAt);
  const requestedPollAt = nowMilliseconds + flow.intervalSeconds * 1000;
  return {
    ...flow,
    nextPollAtMilliseconds: Number.isFinite(expiresAtMilliseconds)
      ? Math.min(requestedPollAt, expiresAtMilliseconds)
      : requestedPollAt,
  };
}

export function withIntegrationPollDelay(
  flow: IntegrationDeviceCodeConnectResult,
  retryAfterSeconds: number | null,
): IntegrationDeviceCodeConnectResult {
  return retryAfterSeconds === null
    ? flow
    : { ...flow, intervalSeconds: Math.max(1, retryAfterSeconds) };
}

export function integrationFlowIsActive(
  flow: IntegrationDeviceCodeConnectResult,
  nowMilliseconds: number,
): boolean {
  const expiresAt = Date.parse(flow.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMilliseconds;
}

export function updateIntegrationFlowIfCurrent<Flow extends { readonly flowId: string }>(
  current: ReadonlyMap<string, Flow>,
  integrationId: string,
  flowId: string,
  next: Flow | null,
): ReadonlyMap<string, Flow> {
  if (current.get(integrationId)?.flowId !== flowId) return current;
  const updated = new Map(current);
  if (next) updated.set(integrationId, next);
  else updated.delete(integrationId);
  return updated;
}
