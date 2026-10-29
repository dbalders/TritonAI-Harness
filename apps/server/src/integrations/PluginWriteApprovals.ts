// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";

import { canonicalJson, type JsonValue } from "@t3tools/shared/pluginSdkContract";

/**
 * Binds Claude's approval of a plugin write to that exact call (thread, tool, arguments) and its
 * service environment, so MCP admission can refuse the call after an environment switch.
 */
export const CLAUDE_CODE_MCP_CLIENT_NAME = "claude-code";

const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_PENDING_PER_THREAD = 256;

interface PendingApproval {
  readonly key: string;
  readonly serviceEnvironment: string;
  readonly expiresAt: number;
}

// Thread id -> approvals in the order they were granted.
const pending = new Map<string, Array<PendingApproval>>();

function approvalKey(toolName: string, input: unknown): string | undefined {
  try {
    const digest = NodeCrypto.createHash("sha256")
      .update(canonicalJson(input as JsonValue))
      .digest("hex");
    return `${toolName}\u0000${digest}`;
  } catch {
    // Arguments that are not plain JSON cannot be matched, so the call finds no approval.
    return undefined;
  }
}

export function recordApprovedServiceEnvironment(input: {
  readonly threadId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly serviceEnvironment: string;
  readonly now?: number;
}): void {
  const key = approvalKey(input.toolName, input.toolInput);
  if (key === undefined) return;
  const now = input.now ?? Date.now();
  const approvals = (pending.get(input.threadId) ?? []).filter(({ expiresAt }) => expiresAt > now);
  approvals.push({
    key,
    serviceEnvironment: input.serviceEnvironment,
    expiresAt: now + APPROVAL_TTL_MS,
  });
  // An evicted approval is refused at admission, never treated as unrestricted.
  pending.set(input.threadId, approvals.slice(-MAX_PENDING_PER_THREAD));
}

/** The oldest approval for exactly this tool and these arguments, removed so it covers one call. */
export function takeApprovedServiceEnvironment(input: {
  readonly threadId: string;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly now?: number;
}): string | undefined {
  const key = approvalKey(input.toolName, input.toolInput);
  const now = input.now ?? Date.now();
  const approvals = (pending.get(input.threadId) ?? []).filter(({ expiresAt }) => expiresAt > now);
  const index = key === undefined ? -1 : approvals.findIndex((approval) => approval.key === key);
  const [approval] = index === -1 ? [] : approvals.splice(index, 1);
  if (approvals.length > 0) pending.set(input.threadId, approvals);
  else pending.delete(input.threadId);
  return approval?.serviceEnvironment;
}
