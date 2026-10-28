import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { dynamicToolApprovalPrompt, invokeAdmittedDynamicTool } from "./CodexDynamicTools.ts";

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

// regression: #400 restore plugin access, failure detail, and approvals after orchestration-v2
it.effect("keeps raw provider errors generic", () =>
  Effect.gen(function* () {
    const response = yield* invokeFailing(new Error("HTTP 500 body with private data"));
    assert.isFalse(response.success);
    assert.equal(responseText(response), "Tool call failed.");
  }),
);

// regression: #400 restore plugin access, failure detail, and approvals after orchestration-v2
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
