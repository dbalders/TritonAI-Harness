import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import type { PreviewAutomationInvokeInput } from "../mcp/PreviewAutomationBroker.ts";
import {
  getCodexPreviewDynamicToolDefinitions,
  invokeCodexPreviewDynamicTool,
} from "./CodexPreviewDynamicTools.ts";

const invocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  requestNamespace: "provider-session-1",
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const status = {
  available: true,
  visible: false,
  tabId: null,
  url: null,
  title: null,
  loading: false,
};

function makeBroker(result: unknown) {
  const invokeCalls: Array<PreviewAutomationInvokeInput> = [];
  const invoke: PreviewAutomationBroker.PreviewAutomationBroker["Service"]["invoke"] = <A>(
    request: PreviewAutomationInvokeInput,
  ) => {
    invokeCalls.push(request);
    return Effect.succeed(result as A);
  };
  return {
    broker: PreviewAutomationBroker.PreviewAutomationBroker.of({
      connect: () => Effect.die("unused"),
      focusHost: () => Effect.die("unused"),
      respond: () => Effect.die("unused"),
      invoke,
    }),
    invokeCalls,
  };
}

it.effect("requires approval for preview actions but not for status reads", () =>
  Effect.gen(function* () {
    const codexPreviewDynamicToolDefinitions = yield* getCodexPreviewDynamicToolDefinitions;
    expect(
      codexPreviewDynamicToolDefinitions.find(({ name }) => name === "preview_status")
        ?.requiresApproval,
    ).toBe(false);
    expect(
      codexPreviewDynamicToolDefinitions.find(({ name }) => name === "preview_act")
        ?.requiresApproval,
    ).toBe(true);
  }),
);

it.layer(
  ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(Layer.provideMerge(NodeServices.layer)),
)("preview tools", (it) => {
  it.effect("uses the current provider session and rejects it after replacement", () =>
    Effect.gen(function* () {
      const { broker, invokeCalls } = makeBroker(status);
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const expectedSession = {
        ...invocationScope.thread,
        environmentId: invocationScope.environmentId,
      };
      const credential = {
        ...expectedSession,
        browserToolsAvailable: true,
        endpoint: "http://127.0.0.1:43123/mcp",
        capabilities: new Set(["preview"] as const),
        authorizationHeader: "Bearer test-token",
      };
      yield* sessions.set(credential);
      yield* invokeCodexPreviewDynamicTool({
        name: "preview_status",
        arguments: {},
        sessionIdentity: expectedSession,
        broker,
      });
      expect(invokeCalls).toHaveLength(1);
      for (const revoked of [
        { ...credential, browserToolsAvailable: false },
        { ...credential, capabilities: new Set<"preview">() },
      ]) {
        yield* sessions.set(revoked);
        const denied = yield* invokeCodexPreviewDynamicTool({
          name: "preview_status",
          arguments: {},
          sessionIdentity: expectedSession,
          broker,
        }).pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
        expect(denied?._tag).toBe("PreviewAutomationUnavailableError");
        expect(invokeCalls).toHaveLength(1);
      }
      yield* sessions.set({ ...credential, providerSessionId: "provider-session-replaced" });
      const error = yield* invokeCodexPreviewDynamicTool({
        name: "preview_status",
        arguments: {},
        sessionIdentity: expectedSession,
        broker,
      }).pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
      expect(error?._tag).toBe("PreviewAutomationUnavailableError");
      expect(invokeCalls).toHaveLength(1);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
