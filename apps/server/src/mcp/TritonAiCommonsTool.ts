import { ServerTritonAiCommonsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as TritonAiCommonsAction from "../provider/TritonAiCommonsAction.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const TRITONAI_COMMONS_SUBMIT_TOOL_NAME = "tritonai_commons_submit_skill";

const TritonAiCommonsToolInput = Schema.Struct({
  skillName: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128))),
  skillPath: Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_192)),
  ),
  confirmedPublicShare: Schema.Literal(true),
});

const decodeToolInput = Schema.decodeUnknownPromise(TritonAiCommonsToolInput);
const schemaDocument = Schema.toJsonSchemaDocument(TritonAiCommonsToolInput);
const isCommonsError = Schema.is(ServerTritonAiCommonsError);

export const tritonAiCommonsDynamicToolDefinition = {
  name: TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
  description:
    "Submit one exact existing local Harness skill to the public TritonAI Commons community collection. Call only after the user explicitly asks to publish/share/submit that skill and confirms the public share. The action validates every text file, uses the connected contributor GitHub identity, and opens a ready-for-review PR; it never merges or changes local files. Provide exactly one unique skillName or exact skillPath.",
  inputSchema:
    Object.keys(schemaDocument.definitions).length > 0
      ? { ...schemaDocument.schema, $defs: schemaDocument.definitions }
      : schemaDocument.schema,
  requiresApproval: true,
} as const;

export type TritonAiCommonsToolResult =
  | {
      readonly status: "review_opened";
      readonly reviewUrl: string;
      readonly path: string;
      readonly skillName: string;
      readonly message: string;
    }
  | {
      readonly status:
        | "approval_required"
        | "invalid_skill"
        | "github_setup_required"
        | "already_exists"
        | "submission_failed"
        | "cancelled";
      readonly message: string;
    };

function safeFailure(cause: unknown): TritonAiCommonsToolResult {
  if (isCommonsError(cause)) {
    return { status: cause.code, message: cause.message };
  }
  return {
    status: "submission_failed",
    message:
      "TritonAI Commons could not open a review. Retry, or finish GitHub setup in Settings > Plugins > GitHub.",
  };
}

export async function invokeTritonAiCommonsTool(input: {
  readonly arguments: unknown;
  readonly providerInstanceId: McpInvocationContext.McpInvocationScope["providerInstanceId"];
  readonly signal: AbortSignal;
  readonly writeApproved: boolean;
  /** Test/embedding override; production resolves the server-lifetime action runtime. */
  readonly runtime?: TritonAiCommonsAction.TritonAiCommonsActionRuntime | null;
}): Promise<TritonAiCommonsToolResult> {
  if (!input.writeApproved) {
    return {
      status: "approval_required",
      message: "Public sharing was not approved. No GitHub write was attempted.",
    };
  }
  let payload: typeof TritonAiCommonsToolInput.Type;
  try {
    payload = await decodeToolInput(input.arguments, {
      errors: "all",
      onExcessProperty: "error",
    });
  } catch {
    return {
      status: "invalid_skill",
      message:
        "Choose exactly one installed skill by unique name or exact SKILL.md path, and explicitly confirm the public share.",
    };
  }
  if (Boolean(payload.skillName) === Boolean(payload.skillPath)) {
    return {
      status: "invalid_skill",
      message:
        "Choose exactly one installed skill by unique name or exact SKILL.md path, and explicitly confirm the public share.",
    };
  }
  const runtime =
    input.runtime === undefined
      ? TritonAiCommonsAction.getTritonAiCommonsActionRuntimeOptional()
      : input.runtime;
  if (!runtime) {
    return {
      status: "submission_failed",
      message: "TritonAI Commons is still starting. Wait a moment, then retry.",
    };
  }
  try {
    const result = await runtime.submit(
      {
        instanceId: input.providerInstanceId,
        ...(payload.skillName ? { skillName: payload.skillName } : {}),
        ...(payload.skillPath ? { skillPath: payload.skillPath } : {}),
        confirmedPublicShare: true,
      },
      input.signal,
    );
    return {
      status: "review_opened",
      reviewUrl: result.reviewUrl,
      path: result.path,
      skillName: result.skillName,
      message:
        "A public TritonAI Commons pull request is ready for maintainer review. Harness did not merge it or change local files.",
    };
  } catch (cause) {
    return safeFailure(cause);
  }
}

const invocationCanSubmit = (): boolean => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  return (
    Context.getOrUndefined(
      fiber.context,
      McpInvocationContext.McpInvocationContext,
    )?.capabilities.has("commons.submit") === true
  );
};

export const registrationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tritonAiCommonsDynamicToolDefinition.name,
        description: tritonAiCommonsDynamicToolDefinition.description,
        inputSchema: tritonAiCommonsDynamicToolDefinition.inputSchema,
        annotations: {
          title: "Submit skill to TritonAI Commons",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      }),
      annotations: Context.make(McpSchema.EnabledWhen, invocationCanSubmit),
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return Effect.tryPromise({
            try: (signal) =>
              invokeTritonAiCommonsTool({
                arguments: payload,
                providerInstanceId: invocation.providerInstanceId,
                signal,
                // The managed provider runtime enforces task approval before issuing a
                // destructive MCP call. The scoped bearer cannot be supplied by a model.
                writeApproved:
                  invocation.capabilities.has("commons.submit") && invocationCanSubmit(),
              }),
            catch: () => "submission_failed" as const,
          }).pipe(
            Effect.orElseSucceed(
              () =>
                ({
                  status: "submission_failed",
                  message: "TritonAI Commons submission was unavailable.",
                }) as const,
            ),
          );
        }).pipe(
          Effect.map(
            (result) =>
              new McpSchema.CallToolResult({
                isError: result.status !== "review_opened",
                structuredContent: result,
                content: [{ type: "text", text: JSON.stringify(result) }],
              }),
          ),
        ),
    });
  }),
);
