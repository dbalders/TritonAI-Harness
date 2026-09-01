import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { IntegrationConnectResult, IntegrationProviderPollResult } from "./integrations.ts";

const decodeConnectResult = Schema.decodeUnknownSync(IntegrationConnectResult);
const decodeProviderPollResult = Schema.decodeUnknownSync(IntegrationProviderPollResult);

const deviceCodeFlow = {
  kind: "device_code",
  flowId: "flow-1",
  verificationUri: "https://example.test/device",
  verificationUriComplete: null,
  userCode: "ABCD-EFGH",
  message: "Finish signing in.",
  expiresAt: "2030-01-01T00:00:00.000Z",
  intervalSeconds: 5,
};

const apiKeyFlow = {
  kind: "api_key",
  flowId: "flow-2",
  label: "API key",
  placeholder: "key_…",
  message: "Enter the service API key.",
  setupUrl: "https://example.test/account/api-keys",
  setupInstructions: ["Open API key settings.", "Create and copy a key."],
};

const authorizationUrlFlow = {
  kind: "authorization_url",
  flowId: "flow-3",
  authorizationUrl:
    "https://accounts.example.test/authorize?client_id=public-client&state=opaque-state",
  message: "Finish signing in in your browser.",
  expiresAt: "2030-01-01T00:00:00.000Z",
  intervalSeconds: 2,
};

describe("IntegrationConnectResult", () => {
  it("decodes the explicit device-code authorization flow", () => {
    expect(decodeConnectResult(deviceCodeFlow)).toEqual(deviceCodeFlow);
  });

  it("decodes API-key entry and completed connection results", () => {
    expect(decodeConnectResult(apiKeyFlow)).toEqual(apiKeyFlow);
    expect(() => decodeConnectResult({ ...apiKeyFlow, setupUrl: "http://example.test" })).toThrow();
    expect(() =>
      decodeConnectResult({ ...apiKeyFlow, setupInstructions: Array(7).fill("Step") }),
    ).toThrow();
    expect(
      decodeConnectResult({ kind: "connected", flowId: "flow-2", message: "Connected." }),
    ).toEqual({ kind: "connected", flowId: "flow-2", message: "Connected." });
  });

  it("decodes a bounded native-browser authorization URL flow", () => {
    expect(decodeConnectResult(authorizationUrlFlow)).toEqual(authorizationUrlFlow);
    expect(() =>
      decodeConnectResult({ ...authorizationUrlFlow, authorizationUrl: "http://example.test" }),
    ).toThrow();
    expect(() =>
      decodeConnectResult({
        ...authorizationUrlFlow,
        authorizationUrl: `https://example.test/${"x".repeat(8_193)}`,
      }),
    ).toThrow();
    expect(() =>
      decodeConnectResult({ ...authorizationUrlFlow, expiresAt: "not-a-timestamp" }),
    ).toThrow();
  });

  it("rejects connection flows without a supported discriminator", () => {
    const { kind: _kind, ...missingKind } = deviceCodeFlow;
    expect(() => decodeConnectResult(missingKind)).toThrow();
    expect(() => decodeConnectResult({ ...deviceCodeFlow, kind: "redirect" })).toThrow();
  });
});

describe("IntegrationProviderPollResult", () => {
  it("rejects invalid retry intervals before a provider commit can be accepted", () => {
    expect(() =>
      decodeProviderPollResult({
        state: "pending",
        retryAfterSeconds: 0,
        message: null,
      }),
    ).toThrow();
  });
});
