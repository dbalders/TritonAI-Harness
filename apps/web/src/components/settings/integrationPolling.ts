import type { IntegrationConnectResult } from "@t3tools/contracts";

export type PollingIntegrationFlow = Extract<
  IntegrationConnectResult,
  { readonly kind: "device_code" | "authorization_url" }
>;

export type ScheduledIntegrationFlow = PollingIntegrationFlow & {
  readonly nextPollAtMilliseconds: number;
};

export function scheduleIntegrationFlow(
  flow: PollingIntegrationFlow,
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
  flow: PollingIntegrationFlow,
  retryAfterSeconds: number | null,
): PollingIntegrationFlow {
  return retryAfterSeconds === null
    ? flow
    : { ...flow, intervalSeconds: Math.max(1, retryAfterSeconds) };
}

export function integrationFlowIsActive(
  flow: PollingIntegrationFlow,
  nowMilliseconds: number,
): boolean {
  const expiresAt = Date.parse(flow.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMilliseconds;
}

export function integrationFlowCanRetryAfterPollError(
  flow: PollingIntegrationFlow,
  nowMilliseconds: number,
): boolean {
  return flow.kind === "device_code" && integrationFlowIsActive(flow, nowMilliseconds);
}

export function integrationConnectResultNeedsPolling(
  flow: IntegrationConnectResult,
): flow is PollingIntegrationFlow {
  return flow.kind === "device_code" || flow.kind === "authorization_url";
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
