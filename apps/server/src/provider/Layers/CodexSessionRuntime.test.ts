import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { describe } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  DEFAULT_TRITONAI_CODEX_MODEL,
  IntegrationOperationError,
  ThreadId,
} from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  INTEGRATION_TOOL_RESULT_OMITTED,
  IntegrationProviderPublicError,
} from "../../integrations/IntegrationRegistry.ts";
import { IntegrationToolUnavailableError } from "../../integrations/IntegrationToolFailure.ts";
import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  computeDynamicToolFingerprint,
  describeMcpElicitation,
  dynamicToolApprovalRequired,
  dynamicToolFailureResponse,
  dynamicToolInvocationAvailable,
  dynamicToolInvocationAllowed,
  gateDynamicToolCall,
  type CodexDynamicToolGate,
  dynamicToolResultResponse,
  hasConfiguredMcpServer,
  computerUseStateForSession,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  openCodexThread,
  readResumeThreadId,
  reconcilePluginSkillAvailability,
  resolvePluginSkillAvailability,
  readCodexThread,
  rollbackCodexThread,
  toMcpElicitationResponse,
  withPluginSkillLease,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("Codex thread history", () => {
  for (const numTurns of [1, 2, 3, 5]) {
    it.effect(`reverts ${numTurns} paginated turns at the durable boundary`, () =>
      Effect.gen(function* () {
        let retained = ["turn-1", "turn-2", "turn-3"];
        const client: Parameters<typeof rollbackCodexThread>[0] = {
          request: () => Effect.die("Legacy history API must not be used for paginated threads"),
          raw: {
            request: (method, params) =>
              Effect.sync(() => {
                if (method === "thread/read") return { thread: { historyMode: "paginated" } };
                if (method === "thread/turns/list") {
                  const { cursor } = params as { cursor: string | null };
                  const start = cursor === null ? 0 : Number(cursor);
                  const ids = retained.slice(start, start + 2);
                  return {
                    data: ids.map((id) => ({ id, items: [], status: "completed" })),
                    nextCursor: start + 2 < retained.length ? String(start + 2) : null,
                  };
                }
                NodeAssert.equal(method, "thread/revert");
                const { beforeTurnId } = params as { beforeTurnId: string };
                retained = retained.slice(0, retained.indexOf(beforeTurnId));
                return { thread: { id: "thread-1", turns: [] } };
              }),
          },
        };
        const result = yield* rollbackCodexThread(client, "thread-1", numTurns);
        const expected = ["turn-1", "turn-2", "turn-3"].slice(0, Math.max(0, 3 - numTurns));
        NodeAssert.deepEqual(
          result.turns.map((turn) => turn.id),
          expected,
        );
        NodeAssert.deepEqual(
          (yield* readCodexThread(client, "thread-1")).turns.map((turn) => turn.id),
          expected,
        );
      }),
    );
  }

  for (const cursors of [
    ["next", "next"],
    ["first", "second", "first"],
  ]) {
    it.effect(`rejects a pagination cursor cycle: ${cursors.join(", ")}`, () =>
      Effect.gen(function* () {
        let pageCount = 0;
        const client: Parameters<typeof readCodexThread>[0] = {
          request: () => Effect.die("Unexpected legacy request"),
          raw: {
            request: (method) =>
              Effect.sync(() => {
                if (method === "thread/read") return { thread: { historyMode: "paginated" } };
                NodeAssert.ok(pageCount < cursors.length, "Repeated cursor was requested");
                return { data: [], nextCursor: cursors[pageCount++] };
              }),
          },
        };
        const error = yield* Effect.flip(readCodexThread(client, "thread-1"));
        NodeAssert.ok(isCodexAppServerRequestError(error));
        NodeAssert.equal(pageCount, cursors.length);
      }),
    );
  }

  it.effect("surfaces Codex rejecting a revert of a legacy thread", () =>
    Effect.gen(function* () {
      const rejection = CodexErrors.CodexAppServerRequestError.invalidRequest(
        "thread/revert only supports paginated threads",
      );
      const client: Parameters<typeof rollbackCodexThread>[0] = {
        raw: {
          request: (method) => {
            if (method === "thread/read") return Effect.succeed({ thread: {} });
            if (method === "thread/revert") return Effect.fail(rejection);
            return Effect.die(`Unexpected raw request: ${method}`);
          },
        },
        request: <M extends CodexRpc.ClientRequestMethod>(method: M) => {
          NodeAssert.equal(method, "thread/read");
          return Effect.succeed({
            thread: { id: "legacy-thread", turns: [{ id: "turn-1", items: [] }] },
          } as unknown as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      const error = yield* Effect.flip(rollbackCodexThread(client, "legacy-thread", 1));
      NodeAssert.strictEqual(error, rejection);
    }),
  );
});

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

  it("resumes the persisted thread even when the granted dynamic tool set changed", () => {
    const cursor = {
      threadId: "provider-thread",
      dynamicToolNames: [recordsTool.name],
      dynamicToolFingerprint: computeDynamicToolFingerprint([recordsTool]),
    };
    NodeAssert.deepStrictEqual(readResumeThreadId(cursor, [recordsTool]), {
      threadId: "provider-thread",
      toolCatalogChanged: false,
    });
    NodeAssert.deepStrictEqual(readResumeThreadId(cursor, [recordsTool, auditTool]), {
      threadId: "provider-thread",
      toolCatalogChanged: true,
    });
    NodeAssert.deepStrictEqual(
      readResumeThreadId(cursor, [{ ...recordsTool, description: "Updated fixture contract." }]),
      { threadId: "provider-thread", toolCatalogChanged: true },
    );
    NodeAssert.deepStrictEqual(readResumeThreadId(cursor, []), {
      threadId: "provider-thread",
      toolCatalogChanged: true,
    });
    NodeAssert.deepStrictEqual(readResumeThreadId({ threadId: "legacy-thread" }, [recordsTool]), {
      threadId: "legacy-thread",
      toolCatalogChanged: true,
    });
    NodeAssert.deepStrictEqual(readResumeThreadId({ threadId: "legacy-thread" }, undefined), {
      threadId: "legacy-thread",
      toolCatalogChanged: false,
    });
    NodeAssert.equal(readResumeThreadId(undefined, [recordsTool]), undefined);
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

  it("tells the agent why a dynamic tool call failed only through safe errors", () => {
    const failureText = (error: unknown) => {
      const response = dynamicToolFailureResponse(error);
      NodeAssert.equal(response.success, false);
      const [item] = response.contentItems;
      return item?.type === "inputText" ? item.text : undefined;
    };
    NodeAssert.equal(
      failureText(
        new IntegrationOperationError({
          code: "invalid_input",
          message:
            'Input for integration tool n8n.update_workflow did not match its declared schema: operations[0].type: Expected "updateNodeParameters"',
        }),
      ),
      'Integration tool call failed (invalid_input): Input for integration tool n8n.update_workflow did not match its declared schema: operations[0].type: Expected "updateNodeParameters"',
    );
    NodeAssert.equal(
      failureText(new IntegrationProviderPublicError("Workflow wf-1 was not found.")),
      "Integration tool call failed: Workflow wf-1 was not found.",
    );
    NodeAssert.equal(
      failureText(new Error("401 from https://n8n.invalid?token=SECRET_TOKEN")),
      "Tool call failed.",
    );
    NodeAssert.equal(
      failureText({ _tag: "IntegrationProviderPublicError", message: "SECRET_TOKEN" }),
      "Tool call failed.",
    );
    NodeAssert.equal(
      failureText(new IntegrationToolUnavailableError("Dynamic tool is unavailable.")),
      "Dynamic tool is unavailable.",
    );
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
    NodeAssert.deepStrictEqual(dynamicToolInvocationAvailable("fixture_records_write", undefined), {
      available: true,
    });
    NodeAssert.equal(
      dynamicToolInvocationAvailable("fixture_records_write", () => ({
        available: false,
        reason: "revoking",
      })).available,
      false,
    );
    NodeAssert.deepStrictEqual(
      dynamicToolInvocationAvailable("fixture_records_write", () => {
        throw new Error("availability lookup failed");
      }),
      {
        available: false,
        reason: "availability_check_failed",
        detail: "Harness could not check whether this tool is available.",
      },
    );
  });

  describe("dynamic tool call gate", () => {
    const moveTool = {
      name: "microsoft365_mail_message_move",
      description: "Move a message.",
      inputSchema: { type: "object" },
      requiresApproval: true,
    } as const;
    const notGranted = {
      available: false,
      canonicalName: "microsoft365.mail.message.move",
      reason: "capability_not_granted",
      detail:
        "the Organize mail capability is enabled but not granted. Reconnect Microsoft 365 in Settings > Plugins to authorize it.",
    } as const;
    const refreshing = {
      available: false,
      canonicalName: "microsoft365.mail.message.move",
      reason: "connection_changing",
      detail: "Microsoft 365 is refreshing its connection. Try again shortly.",
      transient: true,
    } as const;
    const gateOptions = (
      overrides: Partial<Parameters<typeof gateDynamicToolCall>[0]["options"]>,
    ): Parameters<typeof gateDynamicToolCall>[0]["options"] => ({
      threadId: ThreadId.make("thread-gate"),
      dynamicTools: [moveTool],
      invokeDynamicTool: () => Promise.resolve({ moved: true }),
      ...overrides,
    });
    const recordSpans = () => {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      return {
        spans,
        traced: <A, E>(effect: Effect.Effect<A, E>) =>
          effect.pipe(
            Effect.provide(Logger.layer([Logger.tracerLogger])),
            Effect.withTracer(tracer),
          ),
      };
    };
    const responseText = (gate: CodexDynamicToolGate) => {
      NodeAssert.equal(gate.allowed, false);
      if (gate.allowed) return "";
      NodeAssert.equal(gate.response.success, false);
      const [item] = gate.response.contentItems;
      return item?.type === "inputText" ? item.text : "";
    };

    it.effect("refuses with the tool, reason, and fix, and traces the refusal", () =>
      Effect.gen(function* () {
        const { spans, traced } = recordSpans();
        const gate = yield* traced(
          gateDynamicToolCall({
            options: gateOptions({ dynamicToolAvailability: () => notGranted }),
            payload: { tool: moveTool.name },
          }),
        );
        NodeAssert.equal(
          responseText(gate),
          "microsoft365.mail.message.move is unavailable (capability_not_granted): the Organize mail capability is enabled but not granted. Reconnect Microsoft 365 in Settings > Plugins to authorize it.",
        );
        const span = spans.find(({ name }) => name === "integrations.dynamic-tool.rejected");
        NodeAssert.ok(span);
        NodeAssert.equal(span.attributes.get("thread.id"), "thread-gate");
        NodeAssert.equal(span.attributes.get("dynamic_tool.name"), moveTool.name);
        NodeAssert.equal(
          span.attributes.get("integration.tool.name"),
          "microsoft365.mail.message.move",
        );
        NodeAssert.equal(
          span.attributes.get("dynamic_tool.unavailable.reason"),
          "capability_not_granted",
        );
        NodeAssert.equal(span.attributes.get("dynamic_tool.unavailable.detail"), notGranted.detail);
        NodeAssert.ok(
          span.events.some(([name]) => name.includes("integrations.dynamic-tool.rejected")),
        );
      }),
    );

    it.effect("tells the agent a new thread is needed for a tool missing from its session", () =>
      Effect.gen(function* () {
        const { spans, traced } = recordSpans();
        const gate = yield* traced(
          gateDynamicToolCall({
            options: gateOptions({
              dynamicTools: [],
              dynamicToolAvailability: () => ({
                available: true,
                canonicalName: "microsoft365.mail.message.move",
              }),
            }),
            payload: { tool: moveTool.name },
          }),
        );
        NodeAssert.equal(
          responseText(gate),
          "microsoft365.mail.message.move is unavailable (not_in_session): it was not available when this thread's session started. Start a new thread to pick it up.",
        );
        const span = spans.find(({ name }) => name === "integrations.dynamic-tool.rejected");
        NodeAssert.equal(span?.attributes.get("dynamic_tool.unavailable.reason"), "not_in_session");

        const stillRefused = yield* gateDynamicToolCall({
          options: gateOptions({ dynamicTools: [], dynamicToolAvailability: () => notGranted }),
          payload: { tool: moveTool.name },
        });
        NodeAssert.equal(
          responseText(stillRefused),
          `microsoft365.mail.message.move is unavailable (capability_not_granted): ${notGranted.detail} It is also missing from this thread's session (not_in_session), so start a new thread once that is fixed.`,
        );
      }),
    );

    it.effect("waits out a credential refresh and admits the call once it settles", () =>
      Effect.gen(function* () {
        let available = false;
        const waits: Array<string> = [];
        const gate = yield* gateDynamicToolCall({
          options: gateOptions({
            dynamicToolAvailability: () => (available ? { available: true } : refreshing),
            awaitDynamicToolAvailability: async (name) => {
              waits.push(name);
              available = true;
              return { available: true };
            },
          }),
          payload: { tool: moveTool.name },
        });
        NodeAssert.deepStrictEqual(waits, [moveTool.name]);
        NodeAssert.ok(gate.allowed);
        NodeAssert.equal(gate.definition, moveTool);
      }),
    );

    it.effect("refuses with the re-checked reason when the wait does not help", () =>
      Effect.gen(function* () {
        const gate = yield* gateDynamicToolCall({
          options: gateOptions({
            dynamicToolAvailability: () => refreshing,
            awaitDynamicToolAvailability: () => Promise.resolve(notGranted),
          }),
          payload: { tool: moveTool.name },
        });
        NodeAssert.match(responseText(gate), /\(capability_not_granted\)/u);
        const failedWait = yield* gateDynamicToolCall({
          options: gateOptions({
            dynamicToolAvailability: () => refreshing,
            awaitDynamicToolAvailability: () => Promise.reject(new Error("aborted")),
          }),
          payload: { tool: moveTool.name },
        });
        NodeAssert.match(responseText(failedWait), /\(connection_changing\)/u);
      }),
    );

    it.effect("does not wait on a reason that settling cannot change", () =>
      Effect.gen(function* () {
        let waited = false;
        const gate = yield* gateDynamicToolCall({
          options: gateOptions({
            dynamicToolAvailability: () => notGranted,
            awaitDynamicToolAvailability: async () => {
              waited = true;
              return { available: true };
            },
          }),
          payload: { tool: moveTool.name },
        });
        NodeAssert.equal(gate.allowed, false);
        NodeAssert.equal(waited, false);
      }),
    );
  });

  it("binds write-approval metadata into the tool catalog fingerprint", () => {
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
      projectId: null,
      sessionId: "session-1",
      source: "cli",
      turns: [],
      status: { type: "idle" },
      updatedAt: 1_776_470_400,
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it.effect("sends currency skill aliases in Codex's canonical dollar form", () =>
    Effect.gen(function* () {
      for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
        const prose = `${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6 5${symbol}review`;
        const params = yield* buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: `${symbol}review ${symbol}2spec $existing ${prose} ${symbol}last`,
        });

        NodeAssert.deepEqual(params.input, [
          { type: "text", text: `$review $2spec $existing ${prose} $last` },
        ]);
      }
    }),
  );

  it.effect("routes /feedback to the TritonAI feedback skill", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "/feedback The agent stopped early.",
      });

      NodeAssert.deepEqual(params.input, [
        { type: "text", text: "$tritonai-feedback The agent stopped early." },
      ]);
    }),
  );

  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "localImage",
            path: { secret } as unknown as string,
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
          developer_instructions: buildCodexDeveloperInstructions("plan"),
        },
      },
      additionalContext: buildCodexAdditionalContext({
        model: "gpt-5.3-codex",
        reasoningEffort: "medium",
      }),
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
            type: "localImage",
            path: "/tmp/generated.png",
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
          type: "localImage",
          path: "/tmp/generated.png",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default"),
        },
      },
      additionalContext: buildCodexAdditionalContext({
        model: "gpt-5.3-codex",
        reasoningEffort: "medium",
      }),
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
    NodeAssert.ok(
      params.additionalContext?.t3_code_runtime?.value.includes(`as ${DEFAULT_MODEL} with medium`),
    );
  });

  it.effect("names the model by display name and slug in the runtime context", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        modelName: "GPT-5.3-Codex",
        effort: "high",
        interactionMode: "plan",
      });

      NodeAssert.match(
        params.additionalContext?.t3_code_runtime?.value ?? "",
        /as GPT-5\.3-Codex \(model slug: gpt-5\.3-codex\) with high reasoning effort/,
      );
    }),
  );

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
  it("keeps T3 context out of the mode prompt, which the model catalog can replace", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode);
      NodeAssert.match(instructions, /^<collaboration_mode>[\s\S]*<\/collaboration_mode>$/);
      NodeAssert.doesNotMatch(
        instructions,
        /runtime_info|pull_request_linking|preview_|device_|start_session|computer_use_status/,
      );
    }
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

describe("TritonAI computer use context", () => {
  const runtime = { model: "test", reasoningEffort: "medium" };
  const computerUse = (context: ReturnType<typeof buildCodexAdditionalContext>) =>
    `${context.tritonai_computer_use?.value ?? ""}\n${context.computer_use_status?.value ?? ""}`;

  it("supplies session cursor defaults and user overrides without browser tools", () => {
    const context = buildCodexAdditionalContext(runtime, false, {
      enabled: true,
      available: true,
      running: true,
      accessibilityPermission: true,
      screenRecordingPermission: true,
    });
    const instructions = computerUse(context);

    NodeAssert.match(instructions, /## TritonAI Harness computer use/);
    NodeAssert.match(instructions, /start_session/);
    NodeAssert.match(instructions, /end_session/);
    NodeAssert.match(instructions, /after start_session, call set_agent_cursor_motion/);
    NodeAssert.match(instructions, /for that session before interacting/);
    NodeAssert.match(
      instructions,
      /arc_size=0, turn_radius=1, spring=1, and glide_duration_ms=180 as defaults/,
    );
    NodeAssert.match(instructions, /substituting any explicitly user-requested motion values/);
    NodeAssert.match(instructions, /call again only if the user later requests a motion change/);
    NodeAssert.match(
      instructions,
      /cursor motion is unsupported, continue the task without retrying/,
    );
    NodeAssert.equal(context.t3_code_tools, undefined);
  });

  it("does not diagnose missing desktop status as a permission or environment failure", () => {
    const status = buildCodexAdditionalContext(runtime, false).computer_use_status?.value ?? "";
    NodeAssert.match(status, /Desktop startup status: Unknown/);
    NodeAssert.match(status, /failed desktop status check/);
    NodeAssert.match(status, /check Computer use readiness and retry/);
    NodeAssert.doesNotMatch(status, /Settings > General > Computer use/);
  });

  it("tells the agent which desktop permission is missing", () => {
    const status =
      buildCodexAdditionalContext(runtime, false, {
        enabled: true,
        available: true,
        running: false,
        accessibilityPermission: true,
        screenRecordingPermission: false,
      }).computer_use_status?.value ?? "";
    NodeAssert.match(status, /Desktop startup status: Needs permissions/);
    NodeAssert.match(status, /Allow Screen Recording in System Settings/);
    NodeAssert.match(status, /Do not claim the app is missing/);
  });

  it("does not mistake the desktop driver for the browser connection", () => {
    const args = ['mcp_servers.cua-driver.command="cua-driver"'];
    NodeAssert.equal(hasConfiguredMcpServer(args), true);
    NodeAssert.equal(hasConfiguredMcpServer(args, "t3-code"), false);
  });
});

describe("buildCodexAdditionalContext", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };
  const runtimeValue = (context: ReturnType<typeof buildCodexAdditionalContext>) =>
    context.t3_code_runtime?.value ?? "";

  it("describes the harness, model, effort, and Markdown media support", () => {
    const context = buildCodexAdditionalContext(runtime);

    NodeAssert.equal(context.t3_code_runtime?.kind, "application");
    NodeAssert.match(
      runtimeValue(context),
      /<runtime_info>.*Codex harness, as gpt-5\.3-codex with high reasoning effort.*embed images and videos.*Markdown.*<\/runtime_info>/,
    );
  });

  it("varies with the model and effort of each turn", () => {
    NodeAssert.notEqual(
      runtimeValue(
        buildCodexAdditionalContext({ model: "gpt-5.3-codex", reasoningEffort: "medium" }),
      ),
      runtimeValue(buildCodexAdditionalContext({ model: "gpt-5.4", reasoningEffort: "high" })),
    );
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const value = runtimeValue(
      buildCodexAdditionalContext({ model: "gpt\n5.3\ncodex", reasoningEffort: " high\neffort " }),
    );

    NodeAssert.match(value, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(value, /<runtime_info>[^<]*\n/);
  });

  it("tells the agent which model is selected in the current turn", () => {
    const value = runtimeValue(buildCodexAdditionalContext(runtime));

    NodeAssert.match(value, /TritonAI Harness/);
    NodeAssert.doesNotMatch(value, /running in T3 Code/);
    NodeAssert.match(value, /report the model in this current-turn runtime information/);
    NodeAssert.match(value, /not an identity from earlier messages or inherited instructions/);
    NodeAssert.match(value, /not independent verification of the upstream backend/);
  });

  it("keeps every entry under Codex's 1,000 token cap per entry", () => {
    const context = buildCodexAdditionalContext(
      runtime,
      { browser: true, device: true },
      {
        enabled: true,
        available: true,
        running: false,
        accessibilityPermission: false,
        screenRecordingPermission: false,
      },
    );
    for (const entry of Object.values(context)) {
      // Codex estimates 4 bytes per token and truncates the middle of longer values.
      NodeAssert.ok(Buffer.byteLength(entry.value) < 4_000);
    }
  });
});

describe("T3 tool instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools when they are attached", () => {
    const tools = buildCodexAdditionalContext(runtime, true).t3_code_tools?.value ?? "";
    NodeAssert.match(tools, /TritonAI Harness collaborative browser/);
    NodeAssert.match(tools, /preview_status/);
    NodeAssert.match(tools, /preview_open/);
    NodeAssert.match(tools, /show=false/);
    NodeAssert.match(tools, /Do not switch to global browser skills/);
    NodeAssert.doesNotMatch(tools, /device_open/);
  });

  it("describes device tools only when the credential grants them", () => {
    const tools =
      buildCodexAdditionalContext(runtime, { browser: false, device: true }).t3_code_tools?.value ??
      "";
    NodeAssert.match(tools, /device_open/);
    NodeAssert.doesNotMatch(tools, /preview_open/);
  });

  it("omits the tool entry entirely when no tools are attached", () => {
    // Steering away from other browser automation must go with the tools;
    // keeping it would leave the model talked out of its only option.
    const context = buildCodexAdditionalContext(runtime, false);
    NodeAssert.deepStrictEqual(Object.keys(context), [
      "t3_code_runtime",
      "tritonai_computer_use",
      "computer_use_status",
    ]);
  });
});

describe("computerUseStateForSession", () => {
  const ready = {
    enabled: true,
    available: true,
    running: true,
    accessibilityPermission: true,
    screenRecordingPermission: true,
  };
  it("requires the session driver before advertising Ready", () => {
    for (const args of [
      undefined,
      ['mcp_servers.t3-code.url="http://localhost/mcp"'],
      ['mcp_servers.cua-driver.command="cua-driver"', "mcp_servers.cua-driver.enabled=false"],
    ]) {
      const state = computerUseStateForSession(ready, args);
      NodeAssert.equal(state?.running, false);
      NodeAssert.match(
        buildCodexAdditionalContext({ model: "test", reasoningEffort: "medium" }, false, state)
          .computer_use_status?.value ?? "",
        /Desktop startup status: Restart required/,
      );
    }
    NodeAssert.deepStrictEqual(
      computerUseStateForSession(ready, ['mcp_servers.cua-driver.command="cua-driver"']),
      ready,
    );
    NodeAssert.equal(computerUseStateForSession(undefined, undefined), undefined);
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
        projectId: null,
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
          request: (method: string, payload: unknown) => {
            typedCalls.push({ method, payload });
            rawRequestCount += 1;
            return Effect.succeed(makeThreadOpenResponse("existing-provider-thread"));
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
      NodeAssert.equal(rawRequestCount, 1);
      NodeAssert.equal(typedCalls.length, 1);
      NodeAssert.equal(typedCalls[0]?.method, "thread/resume");
      NodeAssert.equal("dynamicTools" in (typedCalls[0]!.payload as object), false);
    }),
  );

  it.effect("resumes metadata when historical turns contain unknown error values", () =>
    Effect.gen(function* () {
      const response = makeThreadOpenResponse("saved-thread");
      const calls: unknown[] = [];
      const opened = yield* openCodexThread({
        client: {
          request: () => Effect.die("A valid resumed thread must not start fresh"),
          raw: {
            request: (method, payload) => {
              calls.push({ method, payload });
              return Effect.succeed({
                ...response,
                thread: {
                  ...response.thread,
                  turns: [
                    {
                      id: "old-turn",
                      status: "failed",
                      items: [],
                      error: {
                        message: "Historical provider error",
                        codexErrorInfo: "misalignment_policy_violation",
                      },
                    },
                  ],
                },
              });
            },
          },
        },
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "auto",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: "fast",
        resumeThreadId: "saved-thread",
      });

      NodeAssert.deepStrictEqual(opened, {
        cwd: response.cwd,
        model: response.model,
        thread: { id: "saved-thread" },
      });
      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/resume",
          payload: {
            threadId: "saved-thread",
            cwd: "/tmp/project",
            model: "gpt-5.3-codex",
            serviceTier: "fast",
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            approvalsReviewer: "auto_review",
            excludeTurns: true,
          },
        },
      ]);
    }),
  );

  it.effect("rejects malformed required resume metadata without starting a fresh thread", () =>
    Effect.gen(function* () {
      for (const invalidMetadata of [
        { cwd: null },
        { model: 42 },
        { thread: { id: null } },
        { thread: {} },
      ]) {
        const error = yield* openCodexThread({
          client: {
            request: () => Effect.die("Invalid resume metadata must not start a fresh thread"),
            raw: {
              request: () =>
                Effect.succeed({ ...makeThreadOpenResponse("saved-thread"), ...invalidMetadata }),
            },
          },
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "saved-thread",
        }).pipe(Effect.flip);

        NodeAssert.ok(isCodexAppServerRequestError(error));
        NodeAssert.equal(error.operation, "decode-payload");
        NodeAssert.equal(error.method, "thread/resume");
      }
    }),
  );

  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        raw: {
          request: (
            method: "thread/resume",
            payload: CodexRpc.ClientRequestParamsByMethod["thread/resume"],
          ) => {
            calls.push({ method, payload });
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          },
        },
        request: (
          method: "thread/start",
          payload: CodexRpc.ClientRequestParamsByMethod["thread/start"],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(started);
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
        request: () => Effect.die("Non-recoverable resume failures must not start a fresh thread"),
        raw: {
          request: () =>
            Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            ),
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
