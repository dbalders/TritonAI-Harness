import { describe, expect, it } from "@effect/vitest";

import {
  integrationFlowIsActive,
  scheduleIntegrationFlow,
  withIntegrationPollDelay,
} from "./integrationPolling";

const flow = {
  flowId: "flow-1",
  verificationUri: "https://fixture.invalid/device",
  verificationUriComplete: null,
  userCode: "ABCD-EFGH",
  message: "Sign in.",
  expiresAt: "2030-01-01T00:00:00.000Z",
  intervalSeconds: 5,
};

describe("withIntegrationPollDelay", () => {
  it("keeps an absolute deadline so unrelated flow updates cannot postpone polling", () => {
    expect(scheduleIntegrationFlow(flow, 1_000).nextPollAtMilliseconds).toBe(6_000);
  });

  it("uses the provider's increased retry delay", () => {
    expect(withIntegrationPollDelay(flow, 10).intervalSeconds).toBe(10);
  });

  it("keeps the current interval when no delay is supplied", () => {
    expect(withIntegrationPollDelay(flow, null)).toBe(flow);
  });

  it("retains transient failures only before the device flow expires", () => {
    expect(integrationFlowIsActive(flow, Date.parse(flow.expiresAt) - 1)).toBe(true);
    expect(integrationFlowIsActive(flow, Date.parse(flow.expiresAt))).toBe(false);
  });
});
