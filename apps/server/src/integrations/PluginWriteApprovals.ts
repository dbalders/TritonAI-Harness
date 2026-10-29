// @effect-diagnostics globalDate:off
/**
 * Hands the service environment a provider approved for a plugin write (such as "Dev") from its
 * approval callback to the MCP call that follows. Providers that approve before MCP dispatch
 * (Claude) record here; the MCP handler takes the record and passes it to registry admission,
 * which refuses the call if the plugin switched environments in between.
 */
const APPROVAL_TTL_MS = 2 * 60_000;
const MAX_PENDING_PER_TOOL = 16;

interface PendingApproval {
  readonly serviceEnvironment: string;
  readonly expiresAt: number;
}

const pending = new Map<string, Array<PendingApproval>>();

const approvalKey = (threadId: string, toolName: string) => `${threadId}\u0000${toolName}`;

export function recordApprovedServiceEnvironment(input: {
  readonly threadId: string;
  readonly toolName: string;
  readonly serviceEnvironment: string;
  readonly now?: number;
}): void {
  const now = input.now ?? Date.now();
  const key = approvalKey(input.threadId, input.toolName);
  const queue = (pending.get(key) ?? []).filter(({ expiresAt }) => expiresAt > now);
  queue.push({ serviceEnvironment: input.serviceEnvironment, expiresAt: now + APPROVAL_TTL_MS });
  pending.set(key, queue.slice(-MAX_PENDING_PER_TOOL));
}

/** The oldest unexpired approval for this thread and tool, removed so it covers one call. */
export function takeApprovedServiceEnvironment(input: {
  readonly threadId: string;
  readonly toolName: string;
  readonly now?: number;
}): string | undefined {
  const now = input.now ?? Date.now();
  const key = approvalKey(input.threadId, input.toolName);
  const queue = (pending.get(key) ?? []).filter(({ expiresAt }) => expiresAt > now);
  const next = queue.shift();
  if (queue.length > 0) pending.set(key, queue);
  else pending.delete(key);
  return next?.serviceEnvironment;
}
