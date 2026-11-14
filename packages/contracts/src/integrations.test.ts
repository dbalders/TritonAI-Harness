import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { IntegrationConnectResult } from "./integrations.ts";

const decodeConnectResult = Schema.decodeUnknownSync(IntegrationConnectResult);

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
});
