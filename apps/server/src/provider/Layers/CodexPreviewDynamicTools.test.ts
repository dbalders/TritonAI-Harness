import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import type { PreviewAutomationInvokeInput } from "../../mcp/PreviewAutomationBroker.ts";
import {
  codexPreviewDynamicToolDefinitions,
  invokeAuthorizedCodexPreviewDynamicTool,
} from "./CodexPreviewDynamicTools.ts";

const encodeUnknownJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

const invocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
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

it("publishes the existing preview toolkit as flat dynamic tools", () => {
  expect(codexPreviewDynamicToolDefinitions.map(({ name }) => name)).toEqual([
    "preview_status",
    "preview_open",
    "preview_navigate",
    "preview_snapshot",
    "preview_click",
    "preview_type",
    "preview_press",
    "preview_scroll",
    "preview_evaluate",
    "preview_wait_for",
  ]);
  expect(
    codexPreviewDynamicToolDefinitions.find(({ name }) => name === "preview_status")
      ?.requiresApproval,
  ).toBe(false);
  expect(
    codexPreviewDynamicToolDefinitions.find(({ name }) => name === "preview_click")
      ?.requiresApproval,
  ).toBe(true);
  expect(
    codexPreviewDynamicToolDefinitions.find(({ name }) => name === "preview_snapshot")?.description,
  ).toContain("Screenshot image bytes are omitted");
});

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
