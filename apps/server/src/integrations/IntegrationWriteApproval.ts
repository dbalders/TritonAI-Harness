// @effect-diagnostics nodeBuiltinImport:off -- Canonical bytes are hashed synchronously before any approval wait.
import type { AuthSessionId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_REVIEW_PAYLOAD_BYTES = 512 * 1024;
const MAX_REVIEW_WIRE_BYTES = 1024 * 1024;
const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 100_000;
const SECRET_FIELD = /secret|password|passphrase|token|api[-_]?key|credential|authorization/iu;

/** Reject unsupported values rather than silently approving JSON's lossy conversion. */
export function snapshotIntegrationInput(input: unknown) {
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  const account = (value: string) => {
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > MAX_INPUT_BYTES) throw new Error("Plugin input exceeds the 4 MiB review limit.");
    return value;
  };
  const visit = (value: unknown, depth: number): { value: Json; canonical: string } => {
    if (++nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH)
      throw new Error("Plugin input is too deeply nested or complex to review.");
    if (value === null || typeof value === "boolean" || typeof value === "string")
      return { value: Object.is(value, -0) ? 0 : value, canonical: account(JSON.stringify(value)) };
    if (typeof value === "number" && Number.isFinite(value))
      return { value, canonical: account(JSON.stringify(value)) };
    if (typeof value !== "object" || value === null)
      throw new Error("Plugin input must contain only finite JSON values.");
    if (NodeUtil.types.isProxy(value)) throw new Error("Plugin input must not contain proxies.");
    const prototype = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new Error("Plugin input must contain only plain JSON objects.");
    if (ancestors.has(value)) throw new Error("Plugin input must not contain cycles.");
    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
        throw new Error("Plugin input must not contain symbol properties.");
      if (Array.isArray(value)) {
        if (
          value.length > MAX_INPUT_NODES ||
          Object.keys(descriptors).some(
            (key) =>
              key !== "length" && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length),
          )
        )
          throw new Error("Plugin arrays must not contain custom properties.");
        const items: Json[] = [];
        const parts: string[] = [];
        account("[]");
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[index];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
            throw new Error("Plugin arrays must not contain gaps or accessors.");
          const child = visit(descriptor.value, depth + 1);
          items.push(child.value);
          parts.push(child.canonical);
          if (index > 0) account(",");
        }
        return { value: Object.freeze(items), canonical: `[${parts.join(",")}]` };
      }
      const record: Record<string, Json> = Object.create(null);
      const parts: string[] = [];
      account("{}");
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor) || !descriptor.enumerable)
          throw new Error("Plugin objects must not contain hidden properties or accessors.");
        const name = account(`${JSON.stringify(key)}:`);
        const child = visit(descriptor.value, depth + 1);
        record[key] = child.value;
        if (parts.length > 0) account(",");
        parts.push(`${name}${child.canonical}`);
      }
      return { value: Object.freeze(record), canonical: `{${parts.join(",")}}` };
    } finally {
      ancestors.delete(value);
    }
  };
  const result = visit(input, 0);
  return Object.freeze({
    ...result,
    digest: NodeCrypto.createHash("sha256")
      .update("harness-plugin-json-v1\0")
      .update(result.canonical)
      .digest("hex"),
  });
}

export function reviewIntegrationInput(input: Json): string {
  const redact = (value: Json): Json => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(redact);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_FIELD.test(key) ? "[redacted credential field]" : redact(child),
      ]),
    );
  };
  const redacted = redact(input);
  const pretty = JSON.stringify(redacted, null, 2);
  if (Buffer.byteLength(JSON.stringify(pretty)) <= MAX_REVIEW_PAYLOAD_BYTES) return pretty;
  const compact = JSON.stringify(redacted);
  if (Buffer.byteLength(JSON.stringify(compact)) <= MAX_REVIEW_PAYLOAD_BYTES) return compact;
  throw new Error(
    "This plugin write is too large for complete review. Split it into smaller changes.",
  );
}

export interface IntegrationWriteInvocation {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

interface IntegrationThreadApprovalOwner {
  readonly kind?: "thread";
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly invocation?: IntegrationWriteInvocation;
}

export interface IntegrationSettingsApprovalOwner {
  readonly kind: "settings";
  readonly sessionId: AuthSessionId;
  readonly connectionId: string;
  readonly submissionId: string;
}

export type IntegrationApprovalOwner =
  | IntegrationThreadApprovalOwner
  | IntegrationSettingsApprovalOwner;

export interface IntegrationWriteReview {
  readonly owner: IntegrationApprovalOwner;
  readonly requestId: string;
  readonly integrationId: string;
  readonly integrationName: string;
  readonly accountLabel: string | null;
  readonly connection: string;
  readonly toolName: string;
  readonly submittedDigest: string;
  readonly effectiveDigest: string;
  readonly payload: string;
  readonly expiresAt: number;
}

/** Leave room for host prompts and live-event envelopes without shortening any reviewed field. */
export function assertIntegrationWriteReviewSize(review: IntegrationWriteReview): void {
  if (Buffer.byteLength(JSON.stringify(review)) > MAX_REVIEW_WIRE_BYTES)
    throw new Error(
      "This plugin write's review metadata is too large. Split it into smaller changes.",
    );
}

export type IntegrationWriteDecision =
  | { readonly approved: false }
  | { readonly approved: true; readonly isCurrent: () => boolean };

type ApprovalGate = (
  review: IntegrationWriteReview,
) => Effect.Effect<IntegrationWriteDecision | undefined>;
const gates = new Map<string, Set<ApprovalGate>>();

const settingsGateKey = (owner: IntegrationSettingsApprovalOwner) =>
  `settings:${owner.sessionId}:${owner.connectionId}:${owner.submissionId}`;

/** Registers a host presenter; disposing it invalidates every outstanding decision it issued. */
function installGate(key: string, gate: ApprovalGate) {
  const registered = gates.get(key) ?? new Set();
  let active = true;
  const scoped: ApprovalGate = (review) =>
    gate(review).pipe(
      Effect.map((decision) =>
        decision?.approved
          ? {
              approved: true as const,
              isCurrent: () => active && decision.isCurrent(),
            }
          : decision,
      ),
    );
  registered.add(scoped);
  gates.set(key, registered);
  return {
    [Symbol.dispose]() {
      active = false;
      registered.delete(scoped);
      if (registered.size === 0) gates.delete(key);
    },
  };
}

export function installIntegrationWriteGate(instanceId: ProviderInstanceId, gate: ApprovalGate) {
  return installGate(`provider:${instanceId}`, gate);
}

export function installSettingsIntegrationWriteGate(
  owner: IntegrationSettingsApprovalOwner,
  gate: ApprovalGate,
) {
  return installGate(settingsGateKey(owner), gate);
}

export const registerIntegrationWriteGate = (
  instanceId: ProviderInstanceId,
  gate: ApprovalGate,
): Effect.Effect<ApprovalGate, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => installIntegrationWriteGate(instanceId, gate)),
    (handle) => Effect.sync(() => handle[Symbol.dispose]()),
  ).pipe(Effect.as(gate));

export const requestIntegrationWriteApproval = Effect.fn("requestIntegrationWriteApproval")(
  function* (review: IntegrationWriteReview) {
    const key =
      review.owner.kind === "settings"
        ? settingsGateKey(review.owner)
        : `provider:${review.owner.providerInstanceId}`;
    for (const gate of gates.get(key) ?? []) {
      const decision = yield* gate(review);
      if (decision !== undefined) return decision;
    }
    // A native runtime's allow decision or Full Access mode cannot stand in for a host decision.
    return { approved: false } as const;
  },
);

const credentialGenerations = new Map<string, number>();
const pendingCredentialMutations = new Map<string, number>();
const admittedCredentialReaders = new Map<string, number>();

export function integrationCredentialGeneration(integrationId: string): number {
  return credentialGenerations.get(integrationId) ?? 0;
}

export function invalidateIntegrationCredentials(integrationId: string): void {
  credentialGenerations.set(integrationId, integrationCredentialGeneration(integrationId) + 1);
}

export function integrationCredentialMutationPending(integrationId: string): boolean {
  return (pendingCredentialMutations.get(integrationId) ?? 0) > 0;
}

export function beginIntegrationCredentialMutation(integrationId: string): () => void {
  if ((admittedCredentialReaders.get(integrationId) ?? 0) > 0)
    throw new Error("Credentials cannot change while an approved plugin write is still settling.");
  invalidateIntegrationCredentials(integrationId);
  pendingCredentialMutations.set(
    integrationId,
    (pendingCredentialMutations.get(integrationId) ?? 0) + 1,
  );
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    invalidateIntegrationCredentials(integrationId);
    const remaining = (pendingCredentialMutations.get(integrationId) ?? 1) - 1;
    if (remaining === 0) pendingCredentialMutations.delete(integrationId);
    else pendingCredentialMutations.set(integrationId, remaining);
  };
}

/** Keep an admitted write on the reviewed account until its actual provider work settles. */
export function retainIntegrationWriteCredentials(integrationId: string): () => void {
  admittedCredentialReaders.set(
    integrationId,
    (admittedCredentialReaders.get(integrationId) ?? 0) + 1,
  );
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const remaining = (admittedCredentialReaders.get(integrationId) ?? 1) - 1;
    if (remaining === 0) admittedCredentialReaders.delete(integrationId);
    else admittedCredentialReaders.set(integrationId, remaining);
  };
}
