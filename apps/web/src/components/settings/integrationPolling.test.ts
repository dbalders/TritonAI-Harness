import { describe, expect, it } from "@effect/vitest";
import type { IntegrationConnectResult } from "@t3tools/contracts";
import {
  integrationFlowCanRetryAfterPollError,
  scheduleIntegrationFlow,
  updateIntegrationFlowIfCurrent,
} from "./integrationPolling";

const flow = {
  kind: "device_code",
  flowId: "flow-1",
  verificationUri: "https://fixture.invalid/device",
  verificationUriComplete: null,
  userCode: "ABCD-EFGH",
  message: "Sign in.",
  expiresAt: "2030-01-01T00:00:00.000Z",
  intervalSeconds: 5,
} satisfies IntegrationConnectResult;

const browserFlow = {
  kind: "authorization_url",
  flowId: "browser-flow-1",
  authorizationUrl: "https://fixture.invalid/authorize",
  message: "Continue in your browser.",
  expiresAt: "2030-01-01T00:00:00.000Z",
  intervalSeconds: 2,
} satisfies IntegrationConnectResult;

describe("withIntegrationPollDelay", () => {
  it("retries recoverable device-code poll errors but clears single-use browser callbacks", () => {
    const beforeExpiry = Date.parse(flow.expiresAt) - 1;
    expect(integrationFlowCanRetryAfterPollError(flow, beforeExpiry)).toBe(true);
    expect(integrationFlowCanRetryAfterPollError(flow, Date.parse(flow.expiresAt))).toBe(false);
    expect(integrationFlowCanRetryAfterPollError(browserFlow, beforeExpiry)).toBe(false);
  });

  it("cannot restore a cleared or replaced flow from a stale poll completion", () => {
    const scheduled = scheduleIntegrationFlow(flow, 1_000);
    const replacement = scheduleIntegrationFlow({ ...flow, flowId: "flow-2" }, 2_000);

    expect(updateIntegrationFlowIfCurrent(new Map(), "plugin", flow.flowId, scheduled)).toEqual(
      new Map(),
    );
    expect(
      updateIntegrationFlowIfCurrent(
        new Map([["plugin", replacement]]),
        "plugin",
        flow.flowId,
        scheduled,
      ),
    ).toEqual(new Map([["plugin", replacement]]));
    expect(
      updateIntegrationFlowIfCurrent(new Map([["plugin", scheduled]]), "plugin", flow.flowId, null),
    ).toEqual(new Map());
  });
});
