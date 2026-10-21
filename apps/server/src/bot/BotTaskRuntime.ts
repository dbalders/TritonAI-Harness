import type {
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
  RuntimeMode,
  ProviderInteractionMode,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { MessageId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** The Bot consumes visible conversation state, never provider reasoning or raw tool payloads. */
export interface BotTaskThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly worktreePath: string | null;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly deletedAt: string | null;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: "running" | "completed" | "error" | "interrupted";
    readonly completedAt?: string | null;
  } | null;
  readonly session: {
    readonly status: "starting" | "running" | "ready" | "error" | "stopped" | "interrupted";
    readonly lastError: string | null;
  } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly assignmentRunConfirmed?: boolean;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly turnId: string | null;
    readonly createdAt: string;
    readonly updatedAt?: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly kind: string;
    readonly summary: string;
    readonly createdAt: string;
    readonly payload?: unknown;
  }>;
}

const iso = (at: DateTime.Utc | null | undefined) => (at ? DateTime.formatIso(at) : null);
const active = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function botThreadState(
  shell: OrchestrationV2ThreadShell,
  projection?: OrchestrationV2ThreadProjection,
  messageId?: string,
): BotTaskThread {
  const ownMessage = messageId
    ? projection?.messages.find((message) => message.id === messageId)
    : undefined;
  const ownRun = ownMessage?.runId
    ? projection?.runs.find((run) => run.id === ownMessage.runId)
    : undefined;
  const status = ownRun?.status ?? shell.status;
  const runId = ownRun?.id ?? shell.latestRunId;
  const nodes = new Set(
    projection?.nodes
      .filter((node) => messageId === undefined || (ownRun && node.runId === ownRun.id))
      .map((node) => node.id),
  );
  const requests = projection?.runtimeRequests.filter(
    (request) => request.status === "pending" && nodes.has(request.nodeId),
  );
  const approvals =
    requests?.filter(
      (request) => request.kind !== "user_input" && request.kind !== "auth_refresh",
    ) ?? [];
  const inputs =
    requests?.filter(
      (request) => request.kind === "user_input" || request.kind === "auth_refresh",
    ) ?? [];
  const pending = shell.pendingRuntimeRequest;
  const hasPendingApprovals = requests
    ? approvals.length > 0
    : !!pending && pending.kind !== "user_input" && pending.kind !== "auth_refresh";
  const hasPendingUserInput = requests
    ? inputs.length > 0
    : !!pending && (pending.kind === "user_input" || pending.kind === "auth_refresh");
  return {
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    worktreePath: shell.worktreePath,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    deletedAt: iso(shell.deletedAt),
    assignmentRunConfirmed: !!ownRun,
    latestTurn: runId
      ? {
          turnId: runId,
          state: active.has(status)
            ? "running"
            : status === "completed"
              ? "completed"
              : status === "idle"
                ? "completed"
                : status === "failed"
                  ? "error"
                  : "interrupted",
          completedAt: iso(ownRun?.completedAt ?? shell.latestRunCompletedAt),
        }
      : null,
    session: {
      status: active.has(status) ? "running" : status === "failed" ? "error" : "ready",
      lastError: shell.lastError ?? null,
    },
    hasPendingApprovals,
    hasPendingUserInput,
    messages: (projection?.messages ?? [])
      .filter(
        (message) =>
          (messageId === undefined ||
            message.id === messageId ||
            (ownRun && message.runId === ownRun.id)) &&
          (message.role === "user" || message.role === "assistant"),
      )
      .map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        streaming: message.streaming,
        turnId: message.runId,
        createdAt: DateTime.formatIso(message.createdAt),
        updatedAt: DateTime.formatIso(message.updatedAt),
      })),
    activities: [...approvals, ...inputs].map((request) => ({
      kind: request.kind === "user_input" ? "user-input.requested" : "approval.requested",
      summary: request.kind === "user_input" ? "Waiting for your answer" : "Waiting for approval",
      createdAt: DateTime.formatIso(request.createdAt),
      payload: { requestId: request.id },
    })),
  };
}

export class BotTaskRuntimeError extends Schema.TaggedError<BotTaskRuntimeError>()(
  "BotTaskRuntimeError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Could not read or update a Bot task in Harness.";
  }
}
const runtimeError = (cause: unknown) => new BotTaskRuntimeError({ cause });

export class BotTaskRuntime extends Context.Service<
  BotTaskRuntime,
  {
    readonly getProjectShellById: (
      id: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, BotTaskRuntimeError>;
    readonly listProjects: Effect.Effect<
      ReadonlyArray<OrchestrationProjectShell>,
      BotTaskRuntimeError
    >;
    readonly getThreadShellById: (
      id: ThreadId,
    ) => Effect.Effect<Option.Option<BotTaskThread>, BotTaskRuntimeError>;
    readonly getThreadDetailById: (
      id: ThreadId,
      options?: { readonly messageId?: string; readonly activityKinds?: ReadonlyArray<string> },
    ) => Effect.Effect<Option.Option<BotTaskThread>, BotTaskRuntimeError>;
    readonly dispatch: (
      command: OrchestrationV2ServerCommand,
    ) => Effect.Effect<unknown, BotTaskRuntimeError>;
  }
>()("t3/bot/BotTaskRuntime") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  return BotTaskRuntime.of({
    getProjectShellById: (id) => projects.getShell(id).pipe(Effect.mapError(runtimeError)),
    listProjects: projects.listShells().pipe(Effect.mapError(runtimeError)),
    getThreadShellById: (id) =>
      threads.getThreadShell(id).pipe(
        Effect.map((shell) => Option.fromNullishOr(shell ? botThreadState(shell) : null)),
        Effect.mapError(runtimeError),
      ),
    getThreadDetailById: (id, options) =>
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(id);
        if (!shell) return Option.none();
        const message = options?.messageId
          ? (yield* threads.getThreadRecords(id, ["messages"], {
              messageIds: [MessageId.make(options.messageId)],
            })).messages[0]
          : undefined;
        const snapshot = yield* threads.getThreadSnapshotWindow(id, {
          rowLimit: 100,
          userTurnLimit: 8,
          ...(message?.runId ? { requiredRunId: message.runId } : {}),
        });
        return Option.some(botThreadState(shell, snapshot.projection, options?.messageId));
      }).pipe(Effect.mapError(runtimeError)),
    dispatch: (command) => threads.dispatch(command).pipe(Effect.mapError(runtimeError)),
  });
});

export const layer = Layer.effect(BotTaskRuntime, make);
