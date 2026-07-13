import type { IntegrationConnectResult } from "@t3tools/contracts";

export type ScheduledIntegrationFlow = IntegrationConnectResult & {
  readonly nextPollAtMilliseconds: number;
};

export function scheduleIntegrationFlow(
  flow: IntegrationConnectResult,
  nowMilliseconds = Date.now(),
): ScheduledIntegrationFlow {
  return {
    ...flow,
    nextPollAtMilliseconds: nowMilliseconds + flow.intervalSeconds * 1000,
  };
}

export function withIntegrationPollDelay(
  flow: IntegrationConnectResult,
  retryAfterSeconds: number | null,
): IntegrationConnectResult {
  return retryAfterSeconds === null
    ? flow
    : { ...flow, intervalSeconds: Math.max(1, retryAfterSeconds) };
}

export function integrationFlowIsActive(
  flow: IntegrationConnectResult,
  nowMilliseconds: number,
): boolean {
  const expiresAt = Date.parse(flow.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMilliseconds;
}
