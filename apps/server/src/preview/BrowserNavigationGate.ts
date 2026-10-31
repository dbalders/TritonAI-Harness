import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { BrowserNavigationRequest } from "./BrowserNavigationApproval.ts";

/**
 * Apply the adapter’s navigation approval gate to MCP preview_open/preview_navigate
 * as well as direct Codex tools, preserving runtime mode and session grants.
 * Providers that approve before MCP dispatch register no gate.
 */
export interface BrowserNavigationAdmissionRequest {
  readonly threadId: ThreadId;
  /** The MCP credential the call used; a replaced credential is refused. */
  readonly credentialId: string;
  readonly toolName: BrowserNavigationRequest["toolName"];
  readonly arguments: unknown;
}

export type BrowserNavigationAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: string };

/** Decides a call for a thread this gate runs; undefined when it does not run the thread. */
export type BrowserNavigationGate = (
  request: BrowserNavigationAdmissionRequest,
) => Effect.Effect<BrowserNavigationAdmission | undefined>;

const gates = new Map<ProviderInstanceId, Set<BrowserNavigationGate>>();

/** Registers a provider session's gate for as long as the scope stays open. */
export const registerBrowserNavigationGate = (
  providerInstanceId: ProviderInstanceId,
  gate: BrowserNavigationGate,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const registered = gates.get(providerInstanceId) ?? new Set();
      registered.add(gate);
      gates.set(providerInstanceId, registered);
    }),
    () =>
      Effect.sync(() => {
        const registered = gates.get(providerInstanceId);
        registered?.delete(gate);
        if (registered?.size === 0) gates.delete(providerInstanceId);
      }),
  );

/**
 * Admits an MCP browser navigation call. A provider instance with no registered gate keeps its
 * existing approval path. One with a gate must have a session that runs the calling thread;
 * otherwise the call is refused rather than let through unapproved.
 */
export const admitBrowserNavigation = Effect.fn("admitBrowserNavigation")(function* (
  providerInstanceId: ProviderInstanceId,
  request: BrowserNavigationAdmissionRequest,
) {
  const registered = gates.get(providerInstanceId);
  if (registered === undefined || registered.size === 0)
    return { admitted: true } as BrowserNavigationAdmission;
  for (const gate of registered) {
    const decision = yield* gate(request);
    if (decision !== undefined) return decision;
  }
  return {
    admitted: false,
    reason:
      "Opening a website needs an active turn in this thread so the user can approve it. Try again during an active turn.",
  } as BrowserNavigationAdmission;
});
