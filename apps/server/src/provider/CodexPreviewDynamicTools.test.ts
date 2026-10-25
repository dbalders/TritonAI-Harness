import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import type { PreviewAutomationInvokeInput } from "../mcp/PreviewAutomationBroker.ts";
import {
  getCodexPreviewDynamicToolDefinitions,
  invokeAuthorizedCodexPreviewDynamicTool,
  invokeCodexPreviewDynamicTool,
} from "./CodexPreviewDynamicTools.ts";

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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

const snapshot: PreviewAutomationSnapshot = {
  url: "https://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example source text",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
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
      codexPreviewDynamicToolDefinitions.find(({ name }) => name === "preview_click")
        ?.requiresApproval,
    ).toBe(true);
  }),
);

it.layer(
  ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(Layer.provideMerge(NodeServices.layer)),
)("preview tools", (it) => {
  it.effect("returns snapshot DOM context without screenshot image data", () => {
    const { broker, invokeCalls } = makeBroker(snapshot);
    return Effect.gen(function* () {
      const result = yield* invokeAuthorizedCodexPreviewDynamicTool({
        name: "preview_snapshot",
        arguments: {},
        invocationScope,
        broker,
      });

      expect(result).toMatchObject({
        url: "https://example.test/",
        visibleText: "Example source text",
        screenshot: { mimeType: "image/png", width: 10, height: 5, omitted: true },
      });
      const encodedResult = yield* encodeUnknownJson(result);
      expect(encodedResult).not.toContain(snapshot.screenshot.data);
      expect(invokeCalls).toHaveLength(1);
    });
  });

  // regression: #417 bound attachment text extraction and browser navigation approval
  it.effect("tells the agent when navigation ended on a different site", () =>
    Effect.gen(function* () {
      const navigate = (url: string, reached: string) =>
        invokeAuthorizedCodexPreviewDynamicTool({
          name: "preview_navigate",
          arguments: { url },
          invocationScope,
          broker: makeBroker({ ...status, url: reached }).broker,
        });
      const redirected = yield* navigate(
        "https://short.example.test/r",
        "https://news.example.org/",
      );
      expect(redirected).toMatchObject({
        url: "https://news.example.org/",
        redirectedFrom: "https://short.example.test/r",
        redirectNotice: expect.stringContaining("different site, news.example.org"),
      });
      const sameSite = yield* navigate(
        "https://short.example.test/r",
        "https://short.example.test/x",
      );
      expect(sameSite).not.toHaveProperty("redirectedFrom");
      const equivalent = yield* navigate("short.example.test/r", "https://short.example.test/r");
      expect(equivalent).not.toHaveProperty("redirectedFrom");
      const fromLocal = yield* navigate(
        "http://localhost:5173/login",
        "https://tracker.example.org/p",
      );
      expect(fromLocal).toMatchObject({
        url: "https://tracker.example.org/p",
        redirectedFrom: "http://localhost:5173/login",
        redirectNotice: expect.stringContaining("different site, tracker.example.org"),
      });
      const localToLocal = yield* navigate("http://localhost:5173/", "http://localhost:5173/x");
      expect(localToLocal).not.toHaveProperty("redirectedFrom");
    }),
  );

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
