// @effect-diagnostics nodeBuiltinImport:off - the persisted tool catalog fingerprint must be synchronous and deterministic.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import type { ThreadId, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";
import {
  describeIntegrationToolFailure,
  describeUnavailableIntegrationTool,
  IntegrationToolUnavailableError,
} from "../integrations/IntegrationToolFailure.ts";
import { describeToolCallForApproval } from "../integrations/IntegrationToolPreview.ts";
import {
  BROWSER_NAVIGATION_GRANT,
  browserNavigationRequest,
  browserProfileRequest,
  describeBrowserNavigationForApproval,
  describeBrowserProfileOpenForApproval,
  isBrowserNavigationTool,
} from "../preview/BrowserNavigationApproval.ts";
export interface CodexDynamicToolOptions {
  readonly threadId: ThreadId;
  readonly dynamicTools?: ReadonlyArray<CodexDynamicToolDefinition>;
  readonly dynamicToolAvailability?: (name: string) => CodexDynamicToolAvailability;
  readonly awaitDynamicToolAvailability?: (
    name: string,
    options: { readonly signal: AbortSignal },
  ) => Promise<CodexDynamicToolAvailability>;
  readonly invokeDynamicTool?: (input: CodexDynamicToolInvocation) => Promise<unknown>;
}
export interface CodexDynamicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Marks a write tool whose confirmation follows the task runtime mode. */
  readonly requiresApproval?: boolean;
}

export interface CodexDynamicToolInvocation {
  readonly name: string;
  readonly arguments: unknown;
  readonly signal: AbortSignal;
  readonly writeApproved?: boolean;
}

export function dynamicToolInvocationAllowed(
  requiresApproval: boolean | undefined,
  decision: ProviderApprovalDecision | undefined,
): boolean {
  return requiresApproval !== true || decision === "accept" || decision === "acceptForSession";
}

export function dynamicToolApprovalRequired(
  requiresApproval: boolean | undefined,
  approvedForSession: boolean,
  runtimeMode: RuntimeMode,
): boolean {
  return requiresApproval === true && runtimeMode !== "full-access" && !approvedForSession;
}

export type CodexDynamicToolAvailability =
  | { readonly available: true; readonly canonicalName?: string }
  | {
      readonly available: false;
      /** Integration tool behind the dynamic name, when there is one. */
      readonly canonicalName?: string;
      readonly reason: string;
      readonly detail?: string;
      /** In-flight provider work (such as a credential refresh) may make the tool available. */
      readonly transient?: boolean;
    };

type CodexDynamicToolUnavailable = Extract<CodexDynamicToolAvailability, { available: false }>;

function dynamicToolInvocationAvailable(
  name: string,
  check: ((name: string) => CodexDynamicToolAvailability) | undefined,
): CodexDynamicToolAvailability {
  if (!check) return { available: true };
  try {
    return check(name);
  } catch {
    return {
      available: false,
      reason: "availability_check_failed",
      detail: "Harness could not check whether this tool is available.",
    };
  }
}

/** Agent-facing text for a dynamic tool the live catalog refuses. */
function dynamicToolUnavailableText(
  name: string,
  availability: CodexDynamicToolUnavailable,
): string {
  return describeUnavailableIntegrationTool({
    toolName: availability.canonicalName ?? name,
    reason: availability.reason,
    ...(availability.detail ? { detail: availability.detail } : {}),
  });
}

/**
 * Agent-facing text for a call to a tool missing from this session's dynamic tool list. Codex fixes
 * the list when a thread's session starts, so only a new thread can pick up a newly available tool.
 */
function dynamicToolNotInSessionText(
  name: string,
  current: CodexDynamicToolAvailability | undefined,
): string {
  if (current && !current.available) {
    return `${dynamicToolUnavailableText(name, current)} It is also missing from this thread's session (not_in_session), so start a new thread once that is fixed.`;
  }
  return `${current?.canonicalName ?? name} is unavailable (not_in_session): it was not available when this thread's session started. Start a new thread to pick it up.`;
}

export interface CodexDynamicToolRejection {
  readonly threadId: ThreadId;
  readonly toolName: string;
  readonly canonicalName?: string | undefined;
  readonly reason: string;
  readonly detail?: string | undefined;
}

/**
 * Records a refused dynamic tool call in the server trace. Logs reach the trace file only as events
 * on an active span, so each rejection gets its own.
 */
const traceDynamicToolRejection = (rejection: CodexDynamicToolRejection) =>
  Effect.logWarning("integrations.dynamic-tool.rejected", rejection).pipe(
    Effect.withSpan("integrations.dynamic-tool.rejected", {
      attributes: {
        "thread.id": rejection.threadId,
        "dynamic_tool.name": rejection.toolName,
        "dynamic_tool.unavailable.reason": rejection.reason,
        ...(rejection.canonicalName ? { "integration.tool.name": rejection.canonicalName } : {}),
        ...(rejection.detail ? { "dynamic_tool.unavailable.detail": rejection.detail } : {}),
      },
    }),
  );

export type CodexDynamicToolGate =
  | { readonly allowed: true; readonly definition: CodexDynamicToolDefinition }
  | { readonly allowed: false; readonly response: EffectCodexSchema.DynamicToolCallResponse };

/**
 * Admits a dynamic tool call only if this session disclosed the tool and it is available now.
 * Transient unavailability is waited out once (bounded by the callback) before refusing. Every
 * refusal is traced and tells the agent which tool failed and why.
 */
export const gateDynamicToolCall = Effect.fn("CodexDynamicTools.gateDynamicToolCall")(
  function* (input: {
    readonly options: Pick<
      CodexDynamicToolOptions,
      | "threadId"
      | "dynamicTools"
      | "dynamicToolAvailability"
      | "awaitDynamicToolAvailability"
      | "invokeDynamicTool"
    >;
    readonly payload: Pick<EffectCodexSchema.DynamicToolCallParams, "tool" | "namespace">;
  }): Effect.fn.Return<CodexDynamicToolGate> {
    const { options, payload } = input;
    const definition = options.dynamicTools?.find((tool) => tool.name === payload.tool);
    if (payload.namespace || !definition || !options.invokeDynamicTool) {
      const current = payload.namespace
        ? undefined
        : options.dynamicToolAvailability
          ? dynamicToolInvocationAvailable(payload.tool, options.dynamicToolAvailability)
          : undefined;
      yield* traceDynamicToolRejection({
        threadId: options.threadId,
        toolName: payload.namespace ? `${payload.namespace}/${payload.tool}` : payload.tool,
        canonicalName: current?.canonicalName,
        reason: "not_in_session",
        detail:
          current?.available === false
            ? current.detail
              ? `${current.reason}: ${current.detail}`
              : current.reason
            : undefined,
      });
      return {
        allowed: false,
        response: dynamicToolResponse(false, dynamicToolNotInSessionText(payload.tool, current)),
      } as const;
    }
    let availability = dynamicToolInvocationAvailable(
      definition.name,
      options.dynamicToolAvailability,
    );
    const awaitAvailability = options.awaitDynamicToolAvailability;
    if (!availability.available && availability.transient && awaitAvailability) {
      const initial = availability;
      availability = yield* Effect.tryPromise((signal) =>
        awaitAvailability(definition.name, { signal }),
      ).pipe(Effect.orElseSucceed(() => initial));
    }
    if (!availability.available) {
      yield* traceDynamicToolRejection({
        threadId: options.threadId,
        toolName: definition.name,
        canonicalName: availability.canonicalName,
        reason: availability.reason,
        detail: availability.detail,
      });
      return {
        allowed: false,
        response: dynamicToolResponse(
          false,
          dynamicToolUnavailableText(definition.name, availability),
        ),
      } as const;
    }
    return { allowed: true, definition } as const;
  },
);

function normalizeDynamicToolNames(
  dynamicTools: ReadonlyArray<CodexDynamicToolDefinition> | undefined,
): ReadonlyArray<string> {
  return [...new Set((dynamicTools ?? []).map((tool) => tool.name))].sort();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function computeDynamicToolFingerprint(
  dynamicTools: ReadonlyArray<CodexDynamicToolDefinition> | undefined,
): string {
  const definitions = [...(dynamicTools ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, description, inputSchema, requiresApproval }) => ({
      name,
      description,
      inputSchema,
      ...(requiresApproval === true ? { requiresApproval: true } : {}),
    }));
  return NodeCrypto.createHash("sha256").update(canonicalJson(definitions), "utf8").digest("hex");
}

export function dynamicToolResponse(
  success: boolean,
  text: string,
): EffectCodexSchema.DynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function serializeDynamicToolResult(value: unknown): string | undefined {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return undefined;
  }
}

/** Tell the agent why a dynamic tool call failed without disclosing unsafe error details. */
function dynamicToolFailureResponse(error: unknown): EffectCodexSchema.DynamicToolCallResponse {
  return dynamicToolResponse(false, describeIntegrationToolFailure(error).text);
}

function dynamicToolResultResponse(
  value: unknown,
): EffectCodexSchema.DynamicToolCallResponse | undefined {
  const serialized = serializeDynamicToolResult(value);
  return serialized === undefined ? undefined : dynamicToolResponse(true, serialized);
}

/** What the user approves: the tool and the change it will make, never a bare tool name. */
export function dynamicToolApprovalPrompt(
  payload: Pick<EffectCodexSchema.DynamicToolCallParams, "tool" | "arguments">,
): string {
  return describeToolCallForApproval(payload.tool, payload.arguments);
}

export interface DynamicToolApprovalPlan {
  readonly requiresApproval: boolean;
  /** The session grant ("Allow for this session") that covers this call. */
  readonly grantKey: string;
  readonly prompt: string;
}

/**
 * What a dynamic tool call needs approved. Plugin writes ask per tool. The two browser tools that
 * load pages decide by destination instead of their static annotation (which made preview_open
 * always ask and preview_navigate never ask): loading an external website asks, under one
 * browsing grant shared by both tools, and a blank tab or local dev server does not. Opening a tab
 * under a named profile (its saved sign-ins) also asks. Every browser call shares the one session
 * grant, because an existing tab's profile is not visible here; the prompt says so.
 * dynamicToolApprovalRequired still exempts Full access.
 */
export function planDynamicToolApproval(input: {
  readonly requiresApproval: boolean | undefined;
  readonly payload: Pick<EffectCodexSchema.DynamicToolCallParams, "tool" | "arguments">;
}): DynamicToolApprovalPlan {
  if (isBrowserNavigationTool(input.payload.tool)) {
    const navigation = browserNavigationRequest(input.payload.tool, input.payload.arguments);
    const profileId = browserProfileRequest(input.payload.tool, input.payload.arguments);
    const grantKey = BROWSER_NAVIGATION_GRANT;
    if (navigation)
      return {
        requiresApproval: true,
        grantKey,
        prompt: describeBrowserNavigationForApproval(navigation),
      };
    if (profileId)
      return {
        requiresApproval: true,
        grantKey,
        prompt: describeBrowserProfileOpenForApproval(profileId),
      };
    return {
      requiresApproval: false,
      grantKey,
      prompt: dynamicToolApprovalPrompt(input.payload),
    };
  }
  return {
    requiresApproval: input.requiresApproval === true,
    grantKey: input.payload.tool,
    prompt:
      input.requiresApproval === true
        ? dynamicToolApprovalPrompt(input.payload)
        : input.payload.tool,
  };
}

class CodexDynamicToolInvocationError extends Data.TaggedError("CodexDynamicToolInvocationError")<{
  readonly cause: unknown;
}> {}

/**
 * Runs a dynamic tool call the gate admitted. The original failure reaches
 * dynamicToolFailureResponse, so the agent learns why the call failed (reconnect,
 * validation, a public provider message), and refusals found at invoke time are traced.
 */
export const invokeAdmittedDynamicTool = (input: {
  readonly options: Pick<CodexDynamicToolOptions, "threadId" | "invokeDynamicTool">;
  readonly invocation: Omit<CodexDynamicToolInvocation, "signal">;
}): Effect.Effect<EffectCodexSchema.DynamicToolCallResponse> => {
  const invoke = input.options.invokeDynamicTool;
  if (!invoke)
    return Effect.succeed(dynamicToolResponse(false, "This tool is unavailable in this session."));
  return Effect.tryPromise({
    try: (signal) => invoke({ ...input.invocation, signal }),
    catch: (cause) => new CodexDynamicToolInvocationError({ cause }),
  }).pipe(
    Effect.matchEffect({
      onFailure: ({ cause }) =>
        (cause instanceof IntegrationToolUnavailableError && cause.details
          ? traceDynamicToolRejection({
              threadId: input.options.threadId,
              toolName: input.invocation.name,
              canonicalName: cause.details.toolName,
              reason: cause.details.reason,
              detail: cause.details.detail,
            })
          : Effect.logWarning("dynamic tool invocation failed", {
              toolName: input.invocation.name,
            }).pipe(Effect.withSpan("integrations.dynamic-tool.failed"))
        ).pipe(Effect.as(dynamicToolFailureResponse(cause))),
      onSuccess: (value) =>
        Effect.succeed(
          dynamicToolResultResponse(value) ??
            dynamicToolResponse(false, "The tool returned an invalid result."),
        ),
    }),
  );
};

export interface CodexPluginSkillDefinition {
  readonly name: string;
  readonly path: string;
  readonly root: string;
}

export interface CodexPluginSkillLease {
  readonly release: () => void;
}

interface PluginSkillAvailabilityInput {
  readonly pluginSkills?: ReadonlyArray<CodexPluginSkillDefinition>;
  readonly isPluginSkillAvailable?: (name: string) => boolean;
}

export interface PluginSkillAvailability {
  readonly skills: ReadonlyArray<CodexPluginSkillDefinition>;
  readonly extraRoots: ReadonlyArray<string>;
}

function resolvePluginSkillAvailability(
  input: PluginSkillAvailabilityInput,
): PluginSkillAvailability {
  const configured = input.pluginSkills ?? [];
  const skills = input.isPluginSkillAvailable
    ? configured.filter((skill) => input.isPluginSkillAvailable!(skill.name))
    : configured;
  return {
    skills,
    extraRoots: skills.map((skill) => skill.root),
  };
}

function samePluginSkillAvailability(
  left: PluginSkillAvailability,
  right: PluginSkillAvailability,
): boolean {
  return (
    left.skills.length === right.skills.length &&
    left.skills.every(
      (skill, index) =>
        skill.name === right.skills[index]?.name &&
        skill.path === right.skills[index]?.path &&
        skill.root === right.skills[index]?.root,
    )
  );
}

export const reconcilePluginSkillAvailability = Effect.fn(
  "CodexDynamicTools.reconcilePluginSkillAvailability",
)(function* <E, R>(
  input: PluginSkillAvailabilityInput,
  setExtraRoots: (extraRoots: ReadonlyArray<string>) => Effect.Effect<unknown, E, R>,
): Effect.fn.Return<PluginSkillAvailability, E, R> {
  if (!input.pluginSkills?.length) return resolvePluginSkillAvailability(input);
  let candidate = resolvePluginSkillAvailability(input);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    yield* setExtraRoots(candidate.extraRoots);
    const current = resolvePluginSkillAvailability(input);
    if (samePluginSkillAvailability(candidate, current)) return current;
    candidate = current;
  }
  yield* setExtraRoots([]);
  return { skills: [], extraRoots: [] };
});

export function withPluginSkillLease<A, E, R>(
  lease: CodexPluginSkillLease | null,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return lease ? effect.pipe(Effect.ensuring(Effect.sync(lease.release))) : effect;
}
