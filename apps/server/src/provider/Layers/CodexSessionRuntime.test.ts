import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, DEFAULT_TRITONAI_CODEX_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { INTEGRATION_TOOL_RESULT_OMITTED } from "../../integrations/IntegrationRegistry.ts";
import {
  buildCodexDeveloperInstructions,
  codexDefaultModeDeveloperInstructions,
  codexPlanModeDeveloperInstructions,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  computeDynamicToolFingerprint,
  describeMcpElicitation,
  dynamicToolApprovalRequired,
  dynamicToolInvocationAvailable,
  dynamicToolInvocationAllowed,
  dynamicToolResultResponse,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  openCodexThread,
  readCompatibleResumeThreadId,
  reconcilePluginSkillAvailability,
  resolvePluginSkillAvailability,
  toMcpElicitationResponse,
  withPluginSkillLease,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

describe("Codex resume cursor compatibility", () => {
  const recordsTool = {
    name: "fixture_records_search",
    description: "Read fixture records.",
    inputSchema: { type: "object" },
  } as const;
  const auditTool = {
    name: "fixture_audit_recent",
    description: "Read fixture audit events.",
    inputSchema: { type: "object" },
  } as const;

  it("resumes only when the persisted and currently granted dynamic tool sets match", () => {
    NodeAssert.equal(
      readCompatibleResumeThreadId(
        {
          threadId: "provider-thread",
          dynamicToolNames: [auditTool.name, recordsTool.name],
          dynamicToolFingerprint: computeDynamicToolFingerprint([auditTool, recordsTool]),
        },
        [recordsTool, auditTool],
      ),
      "provider-thread",
    );
    NodeAssert.equal(
      readCompatibleResumeThreadId(
        {
          threadId: "provider-thread",
          dynamicToolNames: [recordsTool.name],
          dynamicToolFingerprint: computeDynamicToolFingerprint([recordsTool]),
        },
        [recordsTool, auditTool],
      ),
      undefined,
    );
    NodeAssert.equal(
      readCompatibleResumeThreadId(
        {
          threadId: "provider-thread",
          dynamicToolNames: [recordsTool.name],
          dynamicToolFingerprint: computeDynamicToolFingerprint([recordsTool]),
        },
        [{ ...recordsTool, description: "Updated fixture contract." }],
      ),
      undefined,
    );
    NodeAssert.equal(
      readCompatibleResumeThreadId({ threadId: "legacy-thread" }, [recordsTool]),
      undefined,
    );
    NodeAssert.equal(
      readCompatibleResumeThreadId({ threadId: "legacy-thread" }, undefined),
      "legacy-thread",
    );
  });
});

describe("integration write-tool approval", () => {
  it("reports an omitted integration result as a completed dynamic-tool call", () => {
    NodeAssert.deepStrictEqual(dynamicToolResultResponse(INTEGRATION_TOOL_RESULT_OMITTED), {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: '{"resultOmitted":true,"reason":"integration_tool_result_omitted","message":"Integration tool completed, but its result was omitted."}',
        },
      ],
    });
  });

  it("uses the selected runtime mode as the write-tool approval contract", () => {
    NodeAssert.equal(dynamicToolInvocationAllowed(false, undefined), true);
    NodeAssert.equal(dynamicToolInvocationAllowed(true, undefined), false);
    NodeAssert.equal(dynamicToolInvocationAllowed(true, "cancel"), false);
    NodeAssert.equal(dynamicToolInvocationAllowed(true, "decline"), false);
    NodeAssert.equal(dynamicToolInvocationAllowed(true, "accept"), true);
    NodeAssert.equal(dynamicToolInvocationAllowed(true, "acceptForSession"), true);
    NodeAssert.equal(dynamicToolApprovalRequired(true, false, "approval-required"), true);
    NodeAssert.equal(dynamicToolApprovalRequired(true, false, "auto-accept-edits"), true);
    NodeAssert.equal(dynamicToolApprovalRequired(true, false, "full-access"), false);
    NodeAssert.equal(dynamicToolApprovalRequired(true, true, "approval-required"), false);
    NodeAssert.equal(dynamicToolApprovalRequired(false, false, "approval-required"), false);
  });

  it("fails closed before write approval when live availability is revoked", () => {
    NodeAssert.equal(dynamicToolInvocationAvailable("fixture_records_write", undefined), true);
    NodeAssert.equal(
      dynamicToolInvocationAvailable("fixture_records_write", () => false),
      false,
    );
    NodeAssert.equal(
      dynamicToolInvocationAvailable("fixture_records_write", () => {
        throw new Error("availability lookup failed");
      }),
      false,
    );
  });

  it("binds write-approval metadata into resume compatibility", () => {
    const tool = {
      name: "fixture_records_write",
      description: "Change a record.",
      inputSchema: { type: "object" },
    } as const;
    NodeAssert.notEqual(
      computeDynamicToolFingerprint([tool]),
      computeDynamicToolFingerprint([{ ...tool, requiresApproval: true }]),
    );
    NodeAssert.equal(
      computeDynamicToolFingerprint([tool]),
      computeDynamicToolFingerprint([{ ...tool, requiresApproval: false }]),
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.144.0",
      cwd: "/tmp/project",
      ephemeral: false,
      id: threadId,
      createdAt: 1_776_470_400,
      modelProvider: "openai",
      preview: "",
      sessionId: "session-1",
      source: "cli",
      turns: [],
      status: { type: "idle" },
      updatedAt: 1_776_470_400,
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("attaches an explicitly invoked integration-plugin skill", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "$fixture-records summarize the newest record",
        pluginSkills: [
          {
            name: "fixture-records",
            path: "/tmp/plugin-skills/fixture-records/SKILL.md",
            root: "/tmp/plugin-skills/records-root",
          },
          {
            name: "fixture-audit",
            path: "/tmp/plugin-skills/fixture-audit/SKILL.md",
            root: "/tmp/plugin-skills/audit-root",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params.input, [
      { type: "text", text: "$fixture-records summarize the newest record" },
      {
        type: "skill",
        name: "fixture-records",
        path: "/tmp/plugin-skills/fixture-records/SKILL.md",
      },
    ]);
  });

  it.effect("omits collaboration mode when interaction mode is absent", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "readOnly",
        },
        input: [
          {
            type: "text",
            text: "Review",
          },
        ],
      });
    }),
  );
});

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(codexDefaultModeDeveloperInstructions(true)));
    NodeAssert.match(instructions, /TritonAI Harness/);
    NodeAssert.doesNotMatch(instructions, /running in T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /## TritonAI Harness computer use/);
    NodeAssert.match(instructions, /start_session/);
    NodeAssert.match(instructions, /end_session/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(codexPlanModeDeveloperInstructions(true)));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("integration plugin skill availability", () => {
  it("preserves independently rooted skills when another plugin is revoked", () => {
    const available = new Set(["fixture-records"]);
    const records = {
      name: "fixture-records",
      path: "/tmp/plugin-skills/records-root/fixture-records/SKILL.md",
      root: "/tmp/plugin-skills/records-root",
    } as const;
    const audit = {
      name: "fixture-audit",
      path: "/tmp/plugin-skills/audit-root/fixture-audit/SKILL.md",
      root: "/tmp/plugin-skills/audit-root",
    } as const;

    NodeAssert.deepStrictEqual(
      resolvePluginSkillAvailability({
        pluginSkills: [records, audit],
        isPluginSkillAvailable: (name) => available.has(name),
      }),
      { skills: [records], extraRoots: [records.root] },
    );
  });

  it.effect("reconciles revocation during root refresh and omits the skill from the turn", () =>
    Effect.gen(function* () {
      let available = true;
      const rootUpdates: Array<ReadonlyArray<string>> = [];
      const options = {
        pluginSkills: [
          {
            name: "skill-only-fixture",
            path: "/tmp/plugin-skills/fixture-root/skill-only-fixture/SKILL.md",
            root: "/tmp/plugin-skills/fixture-root",
          },
        ],
        isPluginSkillAvailable: () => available,
      } as const;

      const revoked = yield* reconcilePluginSkillAvailability(options, (extraRoots) =>
        Effect.sync(() => {
          rootUpdates.push([...extraRoots]);
          available = false;
        }),
      );
      NodeAssert.deepStrictEqual(rootUpdates, [[options.pluginSkills[0].root], []]);
      NodeAssert.deepStrictEqual(revoked, { skills: [], extraRoots: [] });
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "$skill-only-fixture run the check",
        pluginSkills: revoked.skills,
      });
      NodeAssert.deepStrictEqual(params.input, [
        { type: "text", text: "$skill-only-fixture run the check" },
      ]);
    }),
  );

  it.effect("holds a skill reservation until turn submission settles", () =>
    Effect.gen(function* () {
      const submission = yield* Deferred.make<void>();
      let released = false;
      const fiber = yield* withPluginSkillLease(
        {
          release: () => {
            released = true;
          },
        },
        Deferred.await(submission),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      NodeAssert.equal(released, false);
      yield* Deferred.succeed(submission, undefined);
      yield* Fiber.join(fiber);
      NodeAssert.equal(released, true);
    }),
  );
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      codexDefaultModeDeveloperInstructions(true),
      codexPlanModeDeveloperInstructions(true),
    ]) {
      NodeAssert.match(instructions, /product-native collaborative browser/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /show=false/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    for (const instructions of [
      codexDefaultModeDeveloperInstructions(false),
      codexPlanModeDeveloperInstructions(false),
    ]) {
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
      // Steering away from other browser automation must go with the tools;
      // keeping it would leave the model talked out of its only option.
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      // The rest of the collaboration mode is untouched.
      NodeAssert.match(instructions, /<collaboration_mode>/);
      NodeAssert.match(instructions, /<\/collaboration_mode>/);
    }
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };
    NodeAssert.match(buildCodexDeveloperInstructions("default", runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(
      buildCodexDeveloperInstructions("default", runtime, false),
      /preview_open/,
    );
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });

  it("ignores disabled MCP servers while detecting other active servers", () => {
    NodeAssert.equal(
      hasConfiguredMcpServer([
        "-c",
        'mcp_servers.t3-code.url="http://127.0.0.1/mcp"',
        "-c",
        "mcp_servers.t3-code.enabled=false",
      ]),
      false,
    );
    NodeAssert.equal(
      hasConfiguredMcpServer([
        "-c",
        'mcp_servers.t3-code.url="http://127.0.0.1/mcp"',
        "-c",
        "mcp_servers.t3-code.enabled=false",
        "-c",
        'mcp_servers.other.url="http://127.0.0.1/other"',
      ]),
      true,
    );
  });
});

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("starts Codex with the current canonical TritonAI model", () =>
    Effect.gen(function* () {
      let startPayload: CodexRpc.ClientRequestParamsByMethod["thread/start"] | undefined;
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/start") {
            startPayload = payload as CodexRpc.ClientRequestParamsByMethod["thread/start"];
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: DEFAULT_TRITONAI_CODEX_MODEL,
        serviceTier: undefined,
        resumeThreadId: undefined,
      });

      NodeAssert.equal(startPayload?.model, DEFAULT_TRITONAI_CODEX_MODEL);
    }),
  );

  it.effect("injects integration plugins as ordinary dynamic functions", () =>
    Effect.gen(function* () {
      let rawStartPayload: unknown;
      const client = {
        raw: {
          request: (_method: string, payload: unknown) => {
            rawStartPayload = payload;
            return Effect.succeed(makeThreadOpenResponse("dynamic-thread"));
          },
        },
        request: <M extends "thread/start" | "thread/resume">(
          _method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) =>
          Effect.succeed(
            makeThreadOpenResponse("typed-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          ),
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: DEFAULT_TRITONAI_CODEX_MODEL,
        serviceTier: undefined,
        resumeThreadId: undefined,
        dynamicTools: [
          {
            name: "fixture_records_search",
            description: "Read records through a fixture integration plugin.",
            inputSchema: {
              type: "object",
              properties: { limit: { type: "integer" } },
              additionalProperties: false,
            },
          },
        ],
      });

      NodeAssert.equal(opened.thread.id, "dynamic-thread");
      NodeAssert.deepStrictEqual(rawStartPayload, {
        cwd: "/tmp/project",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
        model: DEFAULT_TRITONAI_CODEX_MODEL,
        dynamicTools: [
          {
            type: "function",
            name: "fixture_records_search",
            description: "Read records through a fixture integration plugin.",
            inputSchema: {
              type: "object",
              properties: { limit: { type: "integer" } },
              additionalProperties: false,
            },
            deferLoading: false,
          },
        ],
      });
    }),
  );

  it.effect("resumes the same thread and relies on its persisted dynamic tool definitions", () =>
    Effect.gen(function* () {
      let rawRequestCount = 0;
      const typedCalls: Array<{ method: string; payload: unknown }> = [];
      const client = {
        raw: {
          request: (_method: string, _payload: unknown) => {
            rawRequestCount += 1;
            return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
          },
        },
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          typedCalls.push({ method, payload });
          return Effect.succeed(
            makeThreadOpenResponse(
              "existing-provider-thread",
            ) as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: DEFAULT_TRITONAI_CODEX_MODEL,
        serviceTier: undefined,
        resumeThreadId: "existing-provider-thread",
        dynamicTools: [
          {
            name: "fixture_records_search",
            description: "Read records through a fixture integration plugin.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });

      NodeAssert.equal(opened.thread.id, "existing-provider-thread");
      NodeAssert.equal(rawRequestCount, 0);
      NodeAssert.equal(typedCalls.length, 1);
      NodeAssert.equal(typedCalls[0]?.method, "thread/resume");
      NodeAssert.equal("dynamicTools" in (typedCalls[0]!.payload as object), false);
    }),
  );

  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
