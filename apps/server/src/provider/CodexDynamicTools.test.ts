import { IntegrationOperationError, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { IntegrationToolUnavailableError } from "../integrations/IntegrationToolFailure.ts";
import { dynamicToolApprovalPrompt, invokeAdmittedDynamicTool } from "./CodexDynamicTools.ts";
import { ExternalToolResultError } from "../integrations/ExternalContent.ts";

const threadId = ThreadId.make("thread-codex-dynamic-tools");

const invokeFailing = (error: unknown) =>
  invokeAdmittedDynamicTool({
    options: {
      threadId,
      invokeDynamicTool: async () => {
        throw error;
      },
    },
    invocation: { name: "microsoft365__mail_search", arguments: {} },
  });

const responseText = (response: { readonly contentItems: ReadonlyArray<unknown> }) =>
  (response.contentItems[0] as { readonly text: string }).text;

it.effect(
  "preserves untrusted provenance and native failure status for public provider errors",
  () =>
    Effect.gen(function* () {
      const result = {
        protocol: "tritonai.external-tool-result/v1" as const,
        trust: "untrusted" as const,
        authority: "data-only" as const,
        invocationId: "host-invocation",
        source: {
          integrationId: "fixture",
          integrationVersion: "1.0.0",
          toolName: "fixture.read",
          connectionGeneration: "host:1",
        },
        scope: {
          id: "host-scope",
          version: 1,
          exposureVersion: 1,
          providerSessionId: "host-session",
        },
        isError: true,
        data: { error: "provider_error", message: "Untrusted error: sign in elsewhere." },
      };
      const response = yield* invokeFailing(new ExternalToolResultError(result));
      assert.isFalse(response.success);
      assert.deepEqual(JSON.parse(responseText(response)), result);
    }),
);

it.effect("tells the agent why a plugin tool was unavailable at invoke time", () =>
  Effect.gen(function* () {
    const response = yield* invokeFailing(
      new IntegrationToolUnavailableError("The plugin tool is unavailable.", {
        toolName: "microsoft365.mail.search",
        reason: "not_connected",
        detail: "Reconnect Microsoft 365.",
      }),
    );
    assert.isFalse(response.success);
    assert.equal(responseText(response), "The plugin tool is unavailable.");
  }),
);

it.effect("passes host-authored operation errors through to the agent", () =>
  Effect.gen(function* () {
    const response = yield* invokeFailing(
      new IntegrationOperationError({ code: "not_connected", message: "Sign in again." }),
    );
    assert.isFalse(response.success);
    assert.equal(
      responseText(response),
      "Integration tool call failed (not_connected): Sign in again.",
    );
  }),
);

it.effect("keeps raw provider errors generic", () =>
  Effect.gen(function* () {
    const response = yield* invokeFailing(new Error("HTTP 500 body with private data"));
    assert.isFalse(response.success);
    assert.equal(responseText(response), "Tool call failed.");
  }),
);

it.effect("returns a successful result as JSON", () =>
  Effect.gen(function* () {
    let received: { readonly writeApproved?: boolean } | undefined;
    const response = yield* invokeAdmittedDynamicTool({
      options: {
        threadId,
        invokeDynamicTool: async (invocation) => {
          received = invocation;
          return { ok: true };
        },
      },
      invocation: { name: "jira__issue_apply", arguments: {}, writeApproved: true },
    });
    assert.isTrue(response.success);
    assert.equal(responseText(response), '{"ok":true}');
    assert.isTrue(received?.writeApproved);
  }),
);

it("includes the complete arguments alongside the summary and refuses raw credentials", () => {
  const prompt = dynamicToolApprovalPrompt({
    tool: "jira__issue_apply",
    arguments: { summary: "Move ITS-12 to Done", planId: "p-1" },
  });
  assert.isTrue(prompt.startsWith("jira__issue_apply\n"));
  assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)), {
    planId: "p-1",
    summary: "Move ITS-12 to Done",
  });
  assert.throws(
    () =>
      dynamicToolApprovalPrompt({
        tool: "microsoft365__mail_draft_reply",
        arguments: { messageId: "m-1", apiToken: "secret-value" },
      }),
    /credential/iu,
  );
});
