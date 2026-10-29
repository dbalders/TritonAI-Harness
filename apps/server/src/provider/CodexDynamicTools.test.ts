import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  dynamicToolApprovalPrompt,
  invokeAdmittedDynamicTool,
  planDynamicToolApproval,
} from "./CodexDynamicTools.ts";

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

// regression: #400 restore plugin access, failure detail, and approvals after orchestration-v2
it("shows the change a plugin write will make in its approval prompt", () => {
  assert.equal(
    dynamicToolApprovalPrompt({
      tool: "jira__issue_apply",
      arguments: { summary: "Move ITS-12 to Done", planId: "p-1" },
    }),
    "jira__issue_apply\nMove ITS-12 to Done",
  );
  assert.equal(
    dynamicToolApprovalPrompt({
      tool: "microsoft365__mail_draft_reply",
      arguments: { messageId: "m-1", apiToken: "secret-value" },
    }),
    'microsoft365__mail_draft_reply\nmessageId: "m-1"\napiToken: [hidden]',
  );
});

it("approves plugin writes per service environment and names it in the prompt", () => {
  const payload = { tool: "n8n__update_workflow", arguments: { workflowId: "wf-1" } };
  const single = planDynamicToolApproval({ requiresApproval: true, payload });
  const dev = planDynamicToolApproval({
    requiresApproval: true,
    payload,
    serviceEnvironment: { id: "development", label: "n8n Dev" },
  });
  const prod = planDynamicToolApproval({
    requiresApproval: true,
    payload,
    serviceEnvironment: { id: "production", label: "n8n Prod" },
  });
  assert.equal(single.grantKey, "n8n__update_workflow");
  assert.equal(dev.grantKey, "n8n__update_workflow@development");
  assert.notEqual(dev.grantKey, prod.grantKey);
  assert.isTrue(dev.prompt.startsWith("n8n__update_workflow (n8n Dev)"));
  assert.include(dev.prompt, 'workflowId: "wf-1"');
});
