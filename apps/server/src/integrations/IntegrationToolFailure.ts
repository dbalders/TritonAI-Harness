import { IntegrationOperationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const MAX_FAILURE_TEXT_LENGTH = 2_000;

/** Why a tool was refused, carried for the trace; the message is what the agent sees. */
export interface IntegrationToolUnavailableDetails {
  readonly toolName: string;
  readonly reason: string;
  readonly detail?: string;
}

/** Thrown by a transport when the requested tool is not bound or is no longer available. */
export class IntegrationToolUnavailableError extends Error {
  readonly _tag = "IntegrationToolUnavailableError";
  readonly details: IntegrationToolUnavailableDetails | undefined;

  constructor(message: string, details?: IntegrationToolUnavailableDetails) {
    super(message);
    this.name = "IntegrationToolUnavailableError";
    this.details = details;
  }
}

/** Agent-facing refusal naming the tool, the reason code, and how to fix it. */
export function describeUnavailableIntegrationTool(details: IntegrationToolUnavailableDetails) {
  return details.detail
    ? `${details.toolName} is unavailable (${details.reason}): ${details.detail}`
    : `${details.toolName} is unavailable (${details.reason}).`;
}

export interface IntegrationToolFailure {
  /** Stable machine-readable code for structured transports. */
  readonly code: string;
  /** Agent-facing explanation. */
  readonly text: string;
}

function bounded(text: string): string {
  return text.length > MAX_FAILURE_TEXT_LENGTH
    ? `${text.slice(0, MAX_FAILURE_TEXT_LENGTH - 1)}…`
    : text;
}

const isIntegrationOperationError = Schema.is(IntegrationOperationError);

function isProviderPublicError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    "_tag" in error &&
    error._tag === "IntegrationProviderPublicError" &&
    error.message.trim().length > 0
  );
}

/**
 * Map an integration tool invocation failure to the text an agent sees, shared by the Codex
 * dynamic-tool and MCP transports. Only host-authored operation errors and provider errors
 * explicitly marked public are described; everything else, including raw provider errors,
 * causes, and cancellations, stays generic so remote bodies and submitted values never leak.
 */
export function describeIntegrationToolFailure(error: unknown): IntegrationToolFailure {
  if (error instanceof IntegrationToolUnavailableError) {
    return { code: "integration_tool_unavailable", text: error.message };
  }
  if (isIntegrationOperationError(error)) {
    return {
      code: error.code,
      text: bounded(`Integration tool call failed (${error.code}): ${error.message}`),
    };
  }
  if (isProviderPublicError(error)) {
    return {
      code: "provider_error",
      text: bounded(`Integration tool call failed: ${error.message}`),
    };
  }
  return { code: "integration_tool_failed", text: "Tool call failed." };
}
