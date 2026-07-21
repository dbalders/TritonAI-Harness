import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_TRITONAI_CODEX_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildTurnStartParams,
  computeDynamicToolFingerprint,
  dynamicToolApprovalRequired,
  dynamicToolInvocationAvailable,
  dynamicToolInvocationAllowed,
  hasConfiguredMcpServer,
  isRecoverableThreadResumeError,
  openCodexThread,
  readCompatibleResumeThreadId,
  reconcilePluginSkillAvailability,
  resolvePluginSkillAvailability,
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
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
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
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

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
      {
        type: "text",
        text: "$fixture-records summarize the newest record",
      },
      {
        type: "skill",
        name: "fixture-records",
        path: "/tmp/plugin-skills/fixture-records/SKILL.md",
      },
    ]);
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
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
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
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
        sandbox: "danger-full-access",
        model: DEFAULT_TRITONAI_CODEX_MODEL,
        dynamicTools: [
          {
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
