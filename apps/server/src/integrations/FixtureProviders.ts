// @effect-diagnostics globalDate:off cryptoRandomUUID:off
import type { IntegrationConnectResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type {
  IntegrationProvider,
  IntegrationProviderStatus,
  IntegrationProviderTool,
} from "./IntegrationRegistry.ts";

export const API_KEY_FIXTURE_SECRET_NAME = "integration-fixture-api-key";
const API_KEY_FIXTURE_VALUE = new TextEncoder().encode("fixture-server-side-api-key");

export class SkillOnlyFixtureProvider implements IntegrationProvider {
  readonly id = "skill-only-fixture-provider";
  readonly tools = [];

  async status(): Promise<IntegrationProviderStatus> {
    return {
      state: "connected",
      accountLabel: "Local instructions only",
      grantedCapabilities: ["workflow.use"],
      message: "No credentials or tools required.",
    };
  }

  connect(): Promise<IntegrationConnectResult> {
    return Promise.reject(new Error("The skill-only fixture does not require a connection."));
  }

  poll(): ReturnType<IntegrationProvider["poll"]> {
    return Promise.reject(new Error("The skill-only fixture has no connection flow."));
  }

  async disconnect(): Promise<void> {}

  invoke(): Promise<unknown> {
    return Promise.reject(new Error("The skill-only fixture intentionally exposes no tools."));
  }
}

export const API_KEY_FIXTURE_TOOLS = [
  {
    name: "fixture.api-key.read",
    description:
      "Read deterministic fixture data through a secret-backed, MCP-compatible provider tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    openWorld: false,
  },
] as const satisfies ReadonlyArray<IntegrationProviderTool>;

export class ApiKeyMcpFixtureProvider implements IntegrationProvider {
  readonly id = "api-key-mcp-fixture-provider";
  readonly tools = API_KEY_FIXTURE_TOOLS;
  readonly #secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly #pending = new Set<string>();

  constructor(secrets: ServerSecretStore.ServerSecretStore["Service"]) {
    this.#secrets = secrets;
  }

  async #hasCredential(): Promise<boolean> {
    return Option.isSome(await Effect.runPromise(this.#secrets.get(API_KEY_FIXTURE_SECRET_NAME)));
  }

  async status(): Promise<IntegrationProviderStatus> {
    const connected = await this.#hasCredential();
    return {
      state: connected ? "connected" : this.#pending.size ? "connecting" : "not_connected",
      accountLabel: connected ? "Sanitized fixture account" : null,
      grantedCapabilities: connected ? ["fixture.read"] : [],
      message: connected
        ? "Fake API key is stored server-side; the value is never exposed."
        : "Test-only provider for the API-key/MCP plugin shape.",
    };
  }

  async connect(capabilities: ReadonlyArray<string>): Promise<IntegrationConnectResult> {
    if (!capabilities.includes("fixture.read")) {
      throw new Error("The fixture read capability is required.");
    }
    const flowId = crypto.randomUUID();
    this.#pending.clear();
    this.#pending.add(flowId);
    return {
      flowId,
      verificationUri: "https://fixture.invalid/api-key",
      verificationUriComplete: null,
      userCode: "FAKE-KEY",
      message: "Harness is simulating server-side API-key configuration for this fixture.",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      intervalSeconds: 1,
    };
  }

  async poll(flowId: string) {
    if (!this.#pending.delete(flowId)) throw new Error("Fixture connection flow was not found.");
    await Effect.runPromise(this.#secrets.set(API_KEY_FIXTURE_SECRET_NAME, API_KEY_FIXTURE_VALUE));
    return {
      state: "connected" as const,
      retryAfterSeconds: null,
      message: "API-key/MCP fixture connected.",
    };
  }

  async disconnect(): Promise<void> {
    this.#pending.clear();
    await Effect.runPromise(this.#secrets.remove(API_KEY_FIXTURE_SECRET_NAME));
  }

  async invoke(toolName: string, _input: unknown): Promise<unknown> {
    if (toolName !== "fixture.api-key.read") throw new Error("Unsupported fixture tool.");
    if (!(await this.#hasCredential())) throw new Error("The API-key fixture is not connected.");
    return {
      source: "api-key-mcp-fixture",
      authenticated: true,
      transportShape: "mcp-compatible-read-only-tool",
      value: "api-key-fixture-ok",
    };
  }
}
