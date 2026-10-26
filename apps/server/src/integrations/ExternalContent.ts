import {
  ExternalToolSource,
  type ExternalContentReview,
  type ExternalToolResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ExternalContentDenied extends Schema.TaggedError<ExternalContentDenied>()(
  "ExternalContentDenied",
  {
    reason: Schema.Literals([
      "runtime_unverified",
      "scope_changed",
      "tool_denied",
      "exposure_changed",
      "invalid_boundary",
      "replayed_invocation",
    ]),
  },
) {
  override get message(): string {
    return "This agent session has not established the required integration-only boundary. No external content was delivered. Returned content cannot authorize additional access.";
  }
}

export class ExternalContentPersistenceError extends Schema.TaggedError<ExternalContentPersistenceError>()(
  "ExternalContentPersistenceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The external-content receipt could not be saved. Its result was withheld. An admitted write may already have completed; do not retry it automatically.";
  }
}

export class ExternalContentWriteOutcomeUnavailable extends Schema.TaggedError<ExternalContentWriteOutcomeUnavailable>()(
  "ExternalContentWriteOutcomeUnavailable",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Write commit was admitted before its result could be delivered. It may already have completed. Check the external record and connection recovery status before retrying; do not retry automatically.";
  }
}

export interface ExternalContentCaller {
  readonly ownerId: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
}

/** Only the host runtime that actually owns enforcement may install this lease. Never an RPC input. */
export interface ExternalContentRuntimeBoundary {
  readonly caller: ExternalContentCaller;
  readonly scopeId: string;
  readonly boundaryDigest: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly expiresAt: number;
  readonly isCurrent: () => boolean;
}

export interface ExternalContentInvocation {
  readonly invocationId: string;
  readonly review: ExternalContentReview;
  /** Check again at the external commit point; newly delivered content invalidates old consent. */
  readonly assertCurrent: (exposureUnchanged?: boolean) => void;
}

export interface ExternalContentRegistry {
  readonly admit: (
    caller: ExternalContentCaller,
    toolName: string,
  ) => Promise<ExternalContentInvocation>;
  readonly record: (
    invocation: ExternalContentInvocation,
    source: ExternalToolSource,
    result: { readonly isError: boolean; readonly data: Record<string, unknown> },
  ) => Promise<ExternalToolResult>;
}

export class ExternalToolResultError extends Error {
  readonly result: ExternalToolResult;
  constructor(result: ExternalToolResult) {
    super("The integration returned an untrusted error result.");
    this.name = "ExternalToolResultError";
    this.result = result;
  }
}

interface ScopeRow {
  readonly scope_id: string;
  readonly scope_version: number;
  readonly exposure_version: number;
  readonly provider_session_id: string;
  readonly provider_instance_id: string;
  readonly boundary_digest: string;
  readonly allowed_tools_json: string;
}

interface ActiveBoundary {
  readonly runtime: ExternalContentRuntimeBoundary;
  readonly scopeVersion: number;
  exposureVersion: number;
}

interface InvocationState {
  readonly caller: ExternalContentCaller;
  readonly boundary: ActiveBoundary;
  readonly invocation: ExternalContentInvocation;
  readonly toolName: string;
  completed: boolean;
}

export class ExternalContent extends Context.Service<
  ExternalContent,
  {
    readonly assertUnexposed: (
      ownerId: string,
    ) => Effect.Effect<void, ExternalContentDenied | ExternalContentPersistenceError>;
    readonly assertInference: (
      caller: ExternalContentCaller,
      requireBoundary?: boolean,
    ) => Effect.Effect<void, ExternalContentDenied | ExternalContentPersistenceError>;
    readonly establish: (
      runtime: ExternalContentRuntimeBoundary,
    ) => Effect.Effect<void, ExternalContentDenied | ExternalContentPersistenceError>;
    readonly revoke: (ownerId: string) => Effect.Effect<void>;
    readonly admit: (
      caller: ExternalContentCaller,
      toolName: string,
    ) => Effect.Effect<
      ExternalContentInvocation,
      ExternalContentDenied | ExternalContentPersistenceError
    >;
    readonly record: (
      invocation: ExternalContentInvocation,
      source: ExternalToolSource,
      result: { readonly isError: boolean; readonly data: Record<string, unknown> },
    ) => Effect.Effect<ExternalToolResult, ExternalContentDenied | ExternalContentPersistenceError>;
  }
>()("t3/integrations/ExternalContent") {}

const identity = (value: string) =>
  value.length > 0 && value.length <= 256 && !/[\p{C}]/u.test(value);

const currentRuntime = (runtime: ExternalContentRuntimeBoundary, now: number) => {
  try {
    return now < runtime.expiresAt && runtime.isCurrent();
  } catch {
    return false;
  }
};

const sameCaller = (left: ExternalContentCaller, right: ExternalContentCaller) =>
  left.ownerId === right.ownerId &&
  left.providerSessionId === right.providerSessionId &&
  left.providerInstanceId === right.providerInstanceId;

const isDenied = Schema.is(ExternalContentDenied);
const sourceCodec = Schema.fromJsonString(ExternalToolSource);
const toolsCodec = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeSource = Schema.decodeUnknownEffect(sourceCodec);
const encodeSource = Schema.encodeEffect(sourceCodec);
const decodeTools = Schema.decodeUnknownEffect(toolsCodec);
const encodeTools = Schema.encodeEffect(toolsCodec);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const clock = yield* Clock.Clock;
  const crypto = yield* Crypto.Crypto;
  const active = new Map<string, ActiveBoundary>();
  const replacements = new Map<string, object>();
  const invocations = new WeakMap<ExternalContentInvocation, InvocationState>();

  const readRow = (ownerId: string) =>
    sql<ScopeRow>`SELECT * FROM external_content_scopes WHERE owner_id = ${ownerId}`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const persistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause): ExternalContentDenied | ExternalContentPersistenceError =>
        isDenied(cause) ? cause : new ExternalContentPersistenceError({ cause }),
      ),
    );

  const assertBoundary = (entry: ActiveBoundary, caller: ExternalContentCaller) => {
    if (
      active.get(caller.ownerId) !== entry ||
      !sameCaller(entry.runtime.caller, caller) ||
      !currentRuntime(entry.runtime, clock.currentTimeMillisUnsafe())
    )
      throw new ExternalContentDenied({ reason: "scope_changed" });
  };

  return ExternalContent.of({
    assertUnexposed: Effect.fn("ExternalContent.assertUnexposed")(function* (ownerId) {
      const row = yield* persistence(readRow(ownerId));
      if (row && row.exposure_version > 0)
        return yield* new ExternalContentDenied({ reason: "runtime_unverified" });
    }),
    assertInference: Effect.fn("ExternalContent.assertInference")(function* (
      caller,
      requireBoundary = false,
    ) {
      const row = yield* persistence(readRow(caller.ownerId));
      const boundary = active.get(caller.ownerId);
      if (!requireBoundary && !boundary && (!row || row.exposure_version === 0)) return;
      if (!boundary) return yield* new ExternalContentDenied({ reason: "runtime_unverified" });
      yield* Effect.try({
        try: () => assertBoundary(boundary, caller),
        catch: () => new ExternalContentDenied({ reason: "scope_changed" }),
      });
      if (
        !row ||
        row.scope_id !== boundary.runtime.scopeId ||
        row.scope_version !== boundary.scopeVersion ||
        row.provider_session_id !== caller.providerSessionId ||
        row.provider_instance_id !== caller.providerInstanceId ||
        row.boundary_digest !== boundary.runtime.boundaryDigest
      )
        return yield* new ExternalContentDenied({ reason: "scope_changed" });
    }),
    establish: Effect.fn("ExternalContent.establish")(function* (input) {
      const caller = Object.freeze({ ...input.caller });
      const tools = [...new Set(input.allowedTools)].sort();
      if (
        !Object.values(caller).every(identity) ||
        !identity(input.scopeId) ||
        !/^[a-f0-9]{64}$/u.test(input.boundaryDigest) ||
        tools.length > 512 ||
        tools.some((name) => !identity(name)) ||
        !Number.isSafeInteger(input.expiresAt) ||
        !currentRuntime(input, clock.currentTimeMillisUnsafe())
      )
        return yield* new ExternalContentDenied({ reason: "invalid_boundary" });
      const runtime = Object.freeze({ ...input, caller, allowedTools: Object.freeze(tools) });
      // A failed replacement must not leave the old process authorized.
      active.delete(caller.ownerId);
      const replacement = {};
      replacements.set(caller.ownerId, replacement);
      const row = yield* persistence(
        sql.withTransaction(
          Effect.gen(function* () {
            const previous = yield* readRow(caller.ownerId);
            if (previous) {
              const priorTools = yield* decodeTools(previous.allowed_tools_json);
              if (previous.exposure_version > 0 && tools.some((tool) => !priorTools.includes(tool)))
                return yield* new ExternalContentDenied({ reason: "tool_denied" });
              if (previous.scope_id === runtime.scopeId)
                return yield* new ExternalContentDenied({ reason: "scope_changed" });
            }
            const scopeVersion = (previous?.scope_version ?? 0) + 1;
            const exposureVersion = previous?.exposure_version ?? 0;
            const encodedTools = yield* encodeTools(tools);
            yield* sql`INSERT INTO external_content_scopes
              (owner_id, scope_id, scope_version, exposure_version, provider_session_id,
               provider_instance_id, boundary_digest, allowed_tools_json)
              VALUES (${caller.ownerId}, ${runtime.scopeId}, ${scopeVersion}, ${exposureVersion},
                ${caller.providerSessionId}, ${caller.providerInstanceId},
                ${runtime.boundaryDigest}, ${encodedTools})
              ON CONFLICT(owner_id) DO UPDATE SET scope_id = excluded.scope_id,
                scope_version = excluded.scope_version,
                provider_session_id = excluded.provider_session_id,
                provider_instance_id = excluded.provider_instance_id,
                boundary_digest = excluded.boundary_digest,
                allowed_tools_json = excluded.allowed_tools_json`;
            return { scopeVersion, exposureVersion };
          }),
        ),
      );
      if (
        replacements.get(caller.ownerId) !== replacement ||
        !currentRuntime(runtime, clock.currentTimeMillisUnsafe())
      )
        return yield* new ExternalContentDenied({ reason: "scope_changed" });
      active.set(caller.ownerId, { runtime, ...row });
    }),
    revoke: (ownerId) =>
      Effect.sync(() => {
        active.delete(ownerId);
        replacements.delete(ownerId);
      }),
    admit: Effect.fn("ExternalContent.admit")(function* (input, toolName) {
      const caller = Object.freeze({ ...input });
      const boundary = active.get(caller.ownerId);
      if (!boundary) return yield* new ExternalContentDenied({ reason: "runtime_unverified" });
      yield* Effect.try({
        try: () => assertBoundary(boundary, caller),
        catch: () => new ExternalContentDenied({ reason: "scope_changed" }),
      });
      if (!boundary.runtime.allowedTools.includes(toolName))
        return yield* new ExternalContentDenied({ reason: "tool_denied" });
      const persisted = yield* persistence(readRow(caller.ownerId));
      if (
        persisted?.scope_id !== boundary.runtime.scopeId ||
        persisted.scope_version !== boundary.scopeVersion ||
        persisted.provider_session_id !== caller.providerSessionId ||
        persisted.provider_instance_id !== caller.providerInstanceId ||
        persisted.boundary_digest !== boundary.runtime.boundaryDigest
      )
        return yield* new ExternalContentDenied({ reason: "scope_changed" });
      boundary.exposureVersion = Math.max(boundary.exposureVersion, persisted.exposure_version);
      const rows = yield* persistence(sql<{ source_json: string }>`
        SELECT source_json FROM external_content_exposures WHERE owner_id = ${caller.ownerId}
        ORDER BY exposure_version DESC LIMIT 8
      `);
      const sources = yield* persistence(
        Effect.forEach(rows, (row) => decodeSource(row.source_json)),
      );
      const exposureVersion = boundary.exposureVersion;
      const invocationId = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => new ExternalContentPersistenceError({ cause })));
      const invocation = Object.freeze({
        invocationId,
        review: Object.freeze({
          scope: Object.freeze({
            id: boundary.runtime.scopeId,
            version: boundary.scopeVersion,
            exposureVersion,
            providerSessionId: caller.providerSessionId,
          }),
          sources: Object.freeze(sources),
        }),
        assertCurrent: (exposureUnchanged = false) => {
          assertBoundary(boundary, caller);
          if (exposureUnchanged && boundary.exposureVersion !== exposureVersion)
            throw new ExternalContentDenied({ reason: "exposure_changed" });
        },
      });
      invocations.set(invocation, {
        caller: Object.freeze({ ...caller }),
        boundary,
        invocation,
        toolName,
        completed: false,
      });
      return invocation;
    }),
    record: Effect.fn("ExternalContent.record")(function* (invocation, source, result) {
      const state = invocations.get(invocation);
      if (!state || state.completed)
        return yield* new ExternalContentDenied({ reason: "replayed_invocation" });
      if (source.toolName !== state.toolName)
        return yield* new ExternalContentDenied({ reason: "tool_denied" });
      state.completed = true;
      yield* Effect.try({
        try: () => invocation.assertCurrent(),
        catch: () => new ExternalContentDenied({ reason: "scope_changed" }),
      });
      const encodedSource = yield* persistence(encodeSource(source));
      const sourceSnapshot = yield* persistence(decodeSource(encodedSource));
      const exposureVersion = yield* persistence(
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* readRow(state.caller.ownerId);
            if (
              !row ||
              row.scope_id !== state.boundary.runtime.scopeId ||
              row.scope_version !== state.boundary.scopeVersion ||
              row.provider_session_id !== state.caller.providerSessionId ||
              row.provider_instance_id !== state.caller.providerInstanceId ||
              row.boundary_digest !== state.boundary.runtime.boundaryDigest
            )
              return yield* new ExternalContentDenied({ reason: "scope_changed" });
            const version = row.exposure_version + 1;
            yield* sql`INSERT INTO external_content_exposures
              (invocation_id, owner_id, scope_id, exposure_version, source_json, received_at)
              VALUES (${invocation.invocationId}, ${state.caller.ownerId}, ${row.scope_id},
                ${version}, ${encodedSource}, ${clock.currentTimeMillisUnsafe()})`;
            yield* sql`UPDATE external_content_scopes SET exposure_version = ${version}
              WHERE owner_id = ${state.caller.ownerId}`;
            return version;
          }),
        ),
      );
      state.boundary.exposureVersion = Math.max(state.boundary.exposureVersion, exposureVersion);
      yield* Effect.try({
        try: () => invocation.assertCurrent(),
        catch: () => new ExternalContentDenied({ reason: "scope_changed" }),
      });
      return Object.freeze({
        protocol: "tritonai.external-tool-result/v1" as const,
        trust: "untrusted" as const,
        authority: "data-only" as const,
        invocationId: invocation.invocationId,
        source: Object.freeze(sourceSnapshot),
        scope: Object.freeze({ ...invocation.review.scope, exposureVersion }),
        isError: result.isError,
        data: result.data,
      });
    }),
  });
});

export const layer = Layer.effect(ExternalContent, make);
