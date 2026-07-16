// @effect-diagnostics globalDate:off cryptoRandomUUID:off
import type { IntegrationConnectionSubmission, IntegrationConnectResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type {
  IntegrationInvocationContext,
  IntegrationLifecycleContext,
  IntegrationProvider,
  IntegrationProviderStatus,
  IntegrationProviderTool,
} from "./IntegrationRegistry.ts";
import { EmptyIntegrationToolInput } from "./IntegrationTool.ts";

export const API_KEY_FIXTURE_SECRET_NAME = "api-key";

export const API_KEY_FIXTURE_TOOLS = [
  {
    name: "fixture.api-key.read",
    description:
      "Read deterministic fixture data through a secret-backed, MCP-compatible provider tool.",
    input: EmptyIntegrationToolInput,
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

  async #hasCredential(signal?: AbortSignal): Promise<boolean> {
    return Option.isSome(
      await Effect.runPromise(this.#secrets.get(API_KEY_FIXTURE_SECRET_NAME), { signal }),
    );
  }

  async status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus> {
    const connected = await this.#hasCredential(context?.signal);
    return {
      state: connected ? "connected" : this.#pending.size ? "connecting" : "not_connected",
      accountLabel: connected ? "Sanitized fixture account" : null,
      grantedCapabilities: connected ? ["fixture.read"] : [],
      message: connected
        ? "The submitted API key is stored server-side; the value is never exposed."
        : "Test-only provider for the generic API-key plugin shape.",
    };
  }

  async connect(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationConnectResult> {
    if (context?.signal.aborted) throw new Error("Fixture connection was cancelled.");
    if (!capabilities.includes("fixture.read")) {
      throw new Error("The fixture read capability is required.");
    }
    if (!submission) {
      const flowId = crypto.randomUUID();
      this.#pending.clear();
      this.#pending.add(flowId);
      return {
        kind: "api_key",
        flowId,
        label: "Fixture API key",
        placeholder: "fixture_…",
        message: "Enter any test-only API key. It will remain in the server secret store.",
      };
    }
    if (!this.#pending.has(submission.flowId)) {
      throw new Error("Fixture connection flow was not found.");
    }
    const commitSignal = await context?.beginCommit();
    await Effect.runPromise(
      this.#secrets.set(API_KEY_FIXTURE_SECRET_NAME, new TextEncoder().encode(submission.value)),
      { signal: commitSignal ?? context?.signal },
    );
    this.#pending.delete(submission.flowId);
    return {
      kind: "connected",
      flowId: submission.flowId,
      message: "API-key MCP fixture connected.",
    };
  }

  async disconnect(context?: IntegrationLifecycleContext): Promise<void> {
    if (context?.signal.aborted) throw new Error("Fixture disconnection was cancelled.");
    const commitSignal = await context?.beginCommit();
    await Effect.runPromise(this.#secrets.remove(API_KEY_FIXTURE_SECRET_NAME), {
      signal: commitSignal ?? context?.signal,
    });
    this.#pending.clear();
  }

  async invoke(
    toolName: string,
    _input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown> {
    if (toolName !== "fixture.api-key.read") throw new Error("Unsupported fixture tool.");
    if (!(await this.#hasCredential(context?.signal))) {
      throw new Error("The API-key fixture is not connected.");
    }
    return {
      source: "api-key-mcp-fixture",
      authenticated: true,
      transportShape: "mcp-compatible-read-only-tool",
      value: "api-key-fixture-ok",
    };
  }
}
