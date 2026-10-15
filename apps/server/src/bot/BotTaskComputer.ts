/**
 * BotTaskComputer - lets this computer run approved TritonAI Bot tasks.
 *
 * Every signed-in Harness can chat with the bot, but only the computer the
 * owner chose with Allow claims approved Harness tasks. Each task becomes an
 * ordinary Harness thread in the chosen project, so the owner can watch it and
 * its existing permissions apply. The worker token stays in the server's
 * secret store; the owner session is used once to pair or stop and is never
 * saved.
 *
 * A claimed task is journaled before its thread is created, and its outcome is
 * saved before delivery. A restart redelivers a saved outcome and never starts
 * a task twice. When the owner allows another computer, this one stops
 * claiming but still delivers what it holds.
 */
// @effect-diagnostics nodeBuiltinImport:off - The computer's name labels it for the owner.
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";

import {
  BotTaskResult,
  type BotTaskThreadProgress,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
  type UploadChatAttachment,
  ProjectId,
  ProviderInstanceId,
  ServerBotTaskComputerError,
  type ServerBotTaskComputerAllowInput,
  type ServerBotTaskComputerProjectInput,
  type ServerBotTaskComputerState,
  type ServerBotTaskComputerStatus,
  type ServerBotTaskComputerStopInput,
  ThreadId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  attachmentFileExtension,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import {
  claimScratchThreadFolder,
  scratchWorkspaceRootFor,
} from "../project/scratchThreadFolder.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ServerConfig } from "../config.ts";
import {
  collectTaskOutputFiles,
  prepareTaskOutputDirectory,
  taskOutputDirectory,
  verifiedAttachmentBytes,
} from "./botTaskFiles.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  BOT_TASK_CAPABILITIES,
  MAX_HELD_TASKS,
  MAX_CLAIMS_PER_PASS,
  botTaskSnapshot,
  consumesBotLaunchSlot,
} from "./botTaskProgress.ts";
import {
  type HeldTask,
  normalizeBotApiUrl,
  type TaskOutcome,
  taskProgress,
  taskPrompt,
  taskThreadTitle,
} from "./botTaskWork.ts";

const STATE_SECRET = "tritonai-bot-task-computer";
const DEVICE_SECRET = "tritonai-bot-device-id";
const STARTUP_DELAY = Duration.seconds(20);
const TICK_INTERVAL = Duration.seconds(10);
const CLAIM_INTERVAL_MS = 20_000;
/** The longest claim the bot grants; a late result is still accepted after it lapses. */
const LEASE_SECONDS = 7200;
const REQUEST_TIMEOUT = Duration.seconds(15);
/** Retry uploads for one day after capturing the completed turn, then report the missing files. */
const OUTPUT_RETRY_WINDOW_MS = 24 * 3_600_000;
const PROJECT_GONE = "The project for TritonAI Bot tasks no longer exists.";

function permanentResultRejection(status: number): boolean {
  return (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    ![401, 408, 409, 425, 429].includes(status)
  );
}
const PermanentResultRejection = Schema.Number.check(Schema.makeFilter(permanentResultRejection));

const AttachmentMetadata = Schema.Struct({
  attachmentId: Schema.String.check(Schema.isPattern(/^att_[a-f0-9]{64}$/u)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180)),
  mimeType: Schema.String,
  size: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(4 * 1024 * 1024),
  ),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const AttachmentBytes = Schema.Struct({
  attachment: AttachmentMetadata,
  dataBase64: Schema.String,
});
const decodeAttachmentMetadata = Schema.decodeUnknownEffect(AttachmentMetadata);
const decodeAttachmentBytes = Schema.decodeUnknownEffect(AttachmentBytes);
const ClaimedTask = Schema.Struct({
  taskId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)),
  userId: Schema.String,
  claimId: Schema.String.check(Schema.isMinLength(1)),
  progressVersion: Schema.optional(Schema.Literal(1)),
  title: Schema.String,
  prompt: Schema.String,
  operation: Schema.optional(Schema.Unknown),
  attachments: Schema.optional(Schema.Array(AttachmentMetadata).check(Schema.isMaxLength(3))),
});
const decodeClaimedTask = Schema.decodeUnknownEffect(ClaimedTask);

const FollowupOperation = Schema.Struct({
  type: Schema.Literal("followup"),
  parentTaskId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)),
});
const decodeFollowupOperation = Schema.decodeUnknownEffect(FollowupOperation);
const Binding = Schema.Struct({
  taskId: Schema.String,
  claimId: Schema.String,
  threadId: Schema.String,
  deviceId: Schema.String,
  projectId: Schema.String,
});
const BindingJson = Schema.fromJsonString(Binding);
const decodeBinding = Schema.decodeUnknownEffect(BindingJson);
const encodeBinding = Schema.encodeEffect(BindingJson);
function bindingKey(stored: Pick<Stored, "apiUrl" | "userId">, taskId: string): string {
  return `tritonai-bot-thread-${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([stored.apiUrl, stored.userId, taskId]))
    .digest("hex")}`;
}

const Outcome = Schema.Struct({
  status: Schema.Literals(["completed", "failed"]),
  result: Schema.String,
  structuredResult: Schema.optional(BotTaskResult),
});
const Held = Schema.Struct({
  taskId: Schema.String,
  claimId: Schema.String,
  title: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  claimedAt: Schema.String,
  /** Negotiated per claim; absent legacy claims never publish fenced progress. */
  progressVersion: Schema.optional(Schema.Literal(1)),
  startedAt: Schema.optional(Schema.String),
  started: Schema.Boolean,
  outcome: Schema.NullOr(Outcome),
  /** Present only until a new operation is dispatched; legacy journals have no assignment. */
  assignment: Schema.optional(ClaimedTask),
  projectId: Schema.optional(Schema.String),
  workspaceKey: Schema.optional(Schema.String),
  outputId: Schema.optional(Schema.String),
  turnCommandId: Schema.optional(Schema.String),
  createCommandId: Schema.optional(Schema.String),
  previousTurnId: Schema.optional(Schema.String),
  deliveryMode: Schema.optional(Schema.Literal("minimal")),
  minimalResult: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  pendingOutputs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(180)),
        mimeType: Schema.String,
        dataBase64: Schema.String.check(Schema.isMaxLength(Math.ceil((4 * 1024 * 1024) / 3) * 4)),
      }),
    ).check(Schema.isMaxLength(3)),
  ),
  outputRetryUntil: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
}).check(
  Schema.makeFilter(
    (task) =>
      (task.deliveryMode === "minimal") === (task.minimalResult !== undefined) ||
      "Incomplete saved result delivery mode.",
  ),
);
const Stored = Schema.Struct({
  version: Schema.Literal(1),
  apiUrl: Schema.String,
  userId: Schema.String,
  token: Schema.String,
  projectId: Schema.String,
  /** False after stopping or being replaced; held results are still delivered. */
  active: Schema.Boolean,
  replaced: Schema.Boolean,
  held: Schema.Array(Held),
  deliveryWarning: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      threadId: Schema.String,
      status: PermanentResultRejection,
    }),
  ),
});
type Stored = typeof Stored.Type;
const StoredJson = Schema.fromJsonString(Stored);
const decodeStored = Schema.decodeUnknownEffect(StoredJson);
const encodeStored = Schema.encodeEffect(StoredJson);
const RecoveryReceipt = Schema.Struct({
  version: Schema.Literal(1),
  apiUrl: Schema.String,
  userId: Schema.String,
  taskId: Schema.String,
  claimId: Schema.String,
  title: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  claimedAt: Schema.String,
  outcome: Outcome,
  rejectedAt: Schema.String,
  rejectedStatus: PermanentResultRejection,
});
const RecoveryReceiptJson = Schema.fromJsonString(RecoveryReceipt);
const encodeRecoveryReceipt = Schema.encodeEffect(RecoveryReceiptJson);
const decodeRecoveryReceipt = Schema.decodeUnknownEffect(RecoveryReceiptJson);

function recoveryReceiptKey(stored: Stored, task: HeldTask): string {
  return `tritonai-bot-result-recovery-${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([stored.apiUrl, stored.userId, task.taskId, task.claimId]))
    .digest("hex")}`;
}

function minimalTaskResult(task: HeldTask & { readonly outcome: TaskOutcome }): string {
  const notice = `The Bot rejected the detailed completion receipt. Structured evidence was not delivered. The original receipt is retained on this task computer. Open Harness thread “${taskThreadTitle(task.title)}” (${task.threadId}) for the full reply.`;
  const complete = `${task.outcome.result}\n\n${notice}`;
  // Check both the text limit and JSON escaping; control-heavy replies can exceed the request limit.
  if (
    Buffer.byteLength(complete) <= 95_000 &&
    Buffer.byteLength(JSON.stringify(complete)) <= 250_000
  )
    return complete;
  return `${task.outcome.result.slice(0, 4000)}\n\n[Reply truncated for delivery.]\n${notice}`;
}

interface RunStatus {
  readonly state: Exclude<ServerBotTaskComputerState, "off" | "running"> | null;
  readonly message: string | null;
  readonly lastCheckInAt: string | null;
  readonly lastCheckInMs: number;
  readonly lastClaimMs: number;
}

type Reply = { readonly status: number; readonly json: Record<string, unknown> };

const failure = (message: string) => new ServerBotTaskComputerError({ message });
const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export class BotTaskComputer extends Context.Service<
  BotTaskComputer,
  {
    readonly getStatus: Effect.Effect<ServerBotTaskComputerStatus>;
    readonly allow: (
      input: ServerBotTaskComputerAllowInput,
    ) => Effect.Effect<ServerBotTaskComputerStatus, ServerBotTaskComputerError>;
    readonly stop: (
      input: ServerBotTaskComputerStopInput,
    ) => Effect.Effect<ServerBotTaskComputerStatus, ServerBotTaskComputerError>;
    readonly setProject: (
      input: ServerBotTaskComputerProjectInput,
    ) => Effect.Effect<ServerBotTaskComputerStatus, ServerBotTaskComputerError>;
    /** One delivery, check-in and claim pass. Never fails. */
    readonly tick: Effect.Effect<void>;
  }
>()("t3/bot/BotTaskComputer") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);

  const deviceBytes = yield* secrets
    .getOrCreateRandom(DEVICE_SECRET, 16)
    .pipe(Effect.orElseSucceed(() => globalThis.crypto.getRandomValues(new Uint8Array(16))));
  const deviceId = Buffer.from(deviceBytes).toString("base64url");
  const deviceName =
    NodeOS.hostname()
      .replace(/\.local$/u, "")
      .trim() || "This computer";

  const status = yield* Ref.make<RunStatus>({
    state: null,
    message: null,
    lastCheckInAt: null,
    lastCheckInMs: 0,
    lastClaimMs: 0,
  });
  const snapshots = yield* Ref.make<
    ReadonlyArray<{
      readonly taskId: string;
      readonly claimId: string;
      readonly progress: BotTaskThreadProgress;
    }>
  >([]);
  const note = (patch: Partial<RunStatus>) =>
    Ref.update(status, (current) => ({ ...current, ...patch }));

  /** Only a missing record is off. Unreadable held work must survive for recovery. */
  const readStored = secrets
    .get(STATE_SECRET)
    .pipe(
      Effect.flatMap((raw) =>
        Option.isNone(raw)
          ? Effect.succeed(null)
          : decodeStored(new TextDecoder().decode(raw.value)),
      ),
    );
  const writeStored = (value: Stored | null) =>
    value === null
      ? secrets.remove(STATE_SECRET)
      : encodeStored(value).pipe(
          Effect.flatMap((json) => secrets.set(STATE_SECRET, new TextEncoder().encode(json))),
        );

  const request = (input: HttpClientRequest.HttpClientRequest) =>
    httpClient.execute(input).pipe(
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.orElseSucceed((): unknown => null),
          Effect.map((json): Reply => ({
            status: response.status,
            json:
              typeof json === "object" && json !== null && !Array.isArray(json)
                ? (json as Record<string, unknown>)
                : {},
          })),
        ),
      ),
      Effect.timeout(REQUEST_TIMEOUT),
    );
  const post = (url: string, headers: Record<string, string>, body: unknown) =>
    request(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
  const workerHeaders = (stored: Stored) => ({
    "x-triton-harness-user": stored.userId,
    "x-triton-harness-token": stored.token,
  });
  const replyError = (reply: Reply, fallback: string) =>
    typeof reply.json.error === "string" && reply.json.error.trim() ? reply.json.error : fallback;

  const projectExists = (projectId: string) =>
    projections.getProjectShellById(ProjectId.make(projectId)).pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
    );

  const getStatus = Effect.gen(function* () {
    const stored = yield* readStored.pipe(Effect.orElseSucceed(() => null));
    const run = yield* Ref.get(status);
    const recent = yield* Ref.get(snapshots);
    const current = stored?.held.find((task) => task.outcome === null) ?? null;
    const state: ServerBotTaskComputerState = !stored
      ? "off"
      : stored.replaced
        ? "replaced"
        : !stored.active
          ? "off"
          : run.state === "error"
            ? "error"
            : current
              ? "running"
              : (run.state ?? "idle");
    const pendingDelivery = stored?.active
      ? stored.held.find((task) => task.outcome !== null)
      : undefined;
    const deliveryMessage = pendingDelivery
      ? `Finished running “${taskThreadTitle(pendingDelivery.title)}”. Its saved result${pendingDelivery.pendingOutputs?.length ? " and files are" : " is"} awaiting delivery to your bot. Retrying automatically. Saved delivery retries continue while other assignments can run.`
      : null;
    const rejectedMessage =
      stored?.active && stored.deliveryWarning
        ? `Your bot could not accept the result for “${taskThreadTitle(stored.deliveryWarning.title)}”. The full result and evidence remain saved on this computer. Open “${taskThreadTitle(stored.deliveryWarning.title)}” in Harness to review it.${state === "idle" && stored.held.length === 0 ? " Other assignments can continue." : ""}`
        : null;
    return {
      state,
      deviceId,
      deviceName,
      apiUrl: stored?.active ? stored.apiUrl : null,
      userId: stored?.userId ?? null,
      projectId: stored?.projectId ?? null,
      tasks:
        stored?.held
          .filter((task) => task.outcome === null)
          .map((task) => {
            const progress = recent.find((item) => item.taskId === task.taskId)?.progress;
            return {
              taskId: task.taskId,
              title: taskThreadTitle(task.title),
              threadId: task.started ? task.threadId : null,
              startedAt: task.startedAt ?? task.claimedAt,
              ...(progress
                ? {
                    phase: progress.phase,
                    pendingApprovals: progress.pendingApprovals,
                    pendingUserInputs: progress.pendingUserInputs,
                  }
                : {}),
            };
          }) ?? [],
      currentTask: current
        ? {
            taskId: current.taskId,
            title: taskThreadTitle(current.title),
            threadId: current.started ? current.threadId : null,
            startedAt: current.startedAt ?? current.claimedAt,
          }
        : null,
      lastCheckInAt: stored?.active ? run.lastCheckInAt : null,
      message:
        [run.message, deliveryMessage, rejectedMessage]
          .filter((message) => message !== null)
          .join(" ") || null,
    } satisfies ServerBotTaskComputerStatus;
  });

  /** Saves the outcome first, so a failed delivery is retried rather than the task rerun. */
  const retainRejectedReceipt = (
    stored: Stored,
    task: HeldTask & { readonly outcome: TaskOutcome },
    rejectedStatus: typeof PermanentResultRejection.Type,
    now: number,
  ) =>
    Effect.gen(function* () {
      const key = recoveryReceiptKey(stored, task);
      const validateExisting = (bytes: Uint8Array) =>
        Effect.gen(function* () {
          const receipt = yield* decodeRecoveryReceipt(new TextDecoder().decode(bytes));
          if (
            receipt.apiUrl !== stored.apiUrl ||
            receipt.userId !== stored.userId ||
            receipt.taskId !== task.taskId ||
            receipt.claimId !== task.claimId
          )
            return yield* failure("Could not validate the retained original task receipt.");
        });
      const existing = yield* secrets.get(key);
      if (Option.isSome(existing)) {
        yield* validateExisting(existing.value);
        return;
      }
      const json = yield* encodeRecoveryReceipt({
        version: 1,
        apiUrl: stored.apiUrl,
        userId: stored.userId,
        taskId: task.taskId,
        claimId: task.claimId,
        title: task.title,
        threadId: task.threadId,
        messageId: task.messageId,
        claimedAt: task.claimedAt,
        outcome: task.outcome,
        rejectedAt: isoAt(now),
        rejectedStatus,
      });
      yield* secrets.create(key, new TextEncoder().encode(json)).pipe(
        Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () =>
          Effect.gen(function* () {
            const saved = yield* secrets.get(key);
            if (Option.isNone(saved))
              return yield* failure("Could not confirm the retained original task receipt.");
            yield* validateExisting(saved.value);
          }),
        ),
      );
    });

  const deliver = (
    stored: Stored,
    task: HeldTask & { readonly outcome: TaskOutcome },
    minimalResult?: string,
  ) =>
    post(`${stored.apiUrl}/harness/results`, workerHeaders(stored), {
      taskId: task.taskId,
      claimId: task.claimId,
      status: task.outcome.status,
      result: minimalResult ?? task.outcome.result,
      ...(minimalResult === undefined && task.outcome.structuredResult
        ? { structuredResult: task.outcome.structuredResult }
        : {}),
    }).pipe(
      // 409 settles a completed or replaced claim. Keep results on 401 so re-pairing can redeliver them.
      Effect.tap((reply) =>
        reply.status === 200 || reply.status === 409
          ? Effect.void
          : Effect.logWarning("bot task result was not accepted", { taskId: task.taskId }),
      ),
      Effect.orElseSucceed(() => null),
    );

  const settleHeld = (initial: Stored, now: number) =>
    Effect.gen(function* () {
      let stored = initial;
      tasks: for (const original of initial.held) {
        let task = original;
        const saveTask = (next: typeof task) =>
          Effect.gen(function* () {
            const nextStored = {
              ...stored,
              held: stored.held.map((item) => (item.taskId === next.taskId ? next : item)),
            };
            yield* writeStored(nextStored);
            stored = nextStored;
            task = next;
          });
        if (task.outcome === null) {
          if (!task.started && task.assignment) continue;
          const thread = task.started
            ? yield* projections
                .getThreadDetailById(ThreadId.make(task.threadId), { activityKinds: [] })
                .pipe(Effect.map(Option.getOrNull), Effect.option)
            : Option.some(null);
          // A failed read is not evidence the thread is gone; check again next pass.
          if (Option.isNone(thread)) continue;
          const progress = taskProgress(thread.value, task, now);
          if (progress.kind === "pending") continue;
          let outcome: TaskOutcome = {
            status: progress.status,
            result: progress.result,
            ...(progress.structuredResult ? { structuredResult: progress.structuredResult } : {}),
          };
          const outputs = outcome.structuredResult
            ? yield* Effect.tryPromise(() =>
                collectTaskOutputFiles(
                  taskOutputDirectory(serverConfig.stateDir, task.outputId ?? task.threadId),
                  platform,
                  { architecture },
                ),
              ).pipe(
                Effect.orElseSucceed(() => ({
                  files: [],
                  blockers: [
                    "Task output files could not be collected. Open the Harness thread for them.",
                  ],
                })),
              )
            : { files: [], blockers: [] };
          if (outcome.structuredResult)
            outcome = {
              ...outcome,
              structuredResult: {
                ...outcome.structuredResult,
                blockers: [...outputs.blockers, ...outcome.structuredResult.blockers].slice(0, 10),
              },
            };
          // Capture the receipt and exact bytes atomically before any remote upload.
          // Later thread edits, deletion, or staged-file changes cannot alter delivery.
          yield* saveTask({
            ...task,
            outcome,
            pendingOutputs: outputs.files,
            outputRetryUntil: now + OUTPUT_RETRY_WINDOW_MS,
          });
        }
        // Existing journals get one durable deadline; restarting never resets the retry window.
        if (task.pendingOutputs?.length && task.outputRetryUntil === undefined)
          yield* saveTask({ ...task, outputRetryUntil: now + OUTPUT_RETRY_WINDOW_MS });
        while (task.pendingOutputs?.length) {
          const file = task.pendingOutputs[0]!;
          const outcome = task.outcome!;
          if (!outcome.structuredResult) {
            yield* saveTask({
              ...task,
              pendingOutputs: [],
              outcome: {
                ...outcome,
                result: `${outcome.result}\n\nTask output files could not be uploaded because their execution receipt is missing. Open the Harness thread for them.`,
              },
            });
            break;
          }
          if (now > task.outputRetryUntil!) {
            yield* saveTask({
              ...task,
              pendingOutputs: [],
              outcome: {
                ...outcome,
                structuredResult: {
                  ...outcome.structuredResult,
                  blockers: [
                    "Task output uploads could not be completed after 24 hours of retries. Open the Harness thread on the task computer to retrieve the files.",
                    ...outcome.structuredResult.blockers,
                  ].slice(0, 10),
                },
              },
            });
            break;
          }
          const reply = yield* post(
            `${stored.apiUrl}/harness/tasks/${task.taskId}/artifacts`,
            workerHeaders(stored),
            { claimId: task.claimId, ...file },
          ).pipe(Effect.option);
          if (Option.isNone(reply)) continue tasks;
          if (yield* handleRejection(stored, reply.value)) {
            return { ...stored, active: false, replaced: reply.value.json.replaced === true };
          }
          const evidence = outcome.structuredResult;
          if (permanentResultRejection(reply.value.status) || reply.value.status === 409) {
            yield* saveTask({
              ...task,
              pendingOutputs: reply.value.status === 404 ? [] : task.pendingOutputs.slice(1),
              outcome: {
                ...outcome,
                structuredResult: {
                  ...evidence,
                  blockers: [
                    reply.value.status === 404
                      ? "This Bot service does not support downloadable task files yet."
                      : `The Bot could not accept output ${file.name}. Open the Harness thread for that file.`,
                    ...evidence.blockers,
                  ].slice(0, 10),
                },
              },
            });
            continue;
          }
          if (reply.value.status !== 200) continue tasks;
          const metadata = yield* decodeAttachmentMetadata(reply.value.json.attachment).pipe(
            Effect.option,
          );
          if (Option.isNone(metadata)) continue tasks;
          const attachment = metadata.value;
          // Persist each receipt before proceeding. If its acknowledgement or journal
          // write is lost, the service's task/content-scoped ID settles an identical retry.
          yield* saveTask({
            ...task,
            pendingOutputs: task.pendingOutputs.slice(1),
            outcome: {
              ...outcome,
              structuredResult: {
                ...evidence,
                artifacts: [
                  {
                    label: attachment.name,
                    uri: `attachment:${attachment.attachmentId}`,
                    kind: "artifact" as const,
                    provenance: "harness-upload" as const,
                    attachmentId: attachment.attachmentId,
                  },
                  ...evidence.artifacts,
                ].slice(0, 20),
              },
            },
          });
        }
        let reply = yield* deliver(
          stored,
          { ...task, outcome: task.outcome! },
          task.deliveryMode === "minimal" ? task.minimalResult : undefined,
        );
        if (reply === null) continue;
        if (yield* handleRejection(stored, reply)) {
          return { ...stored, active: false, replaced: reply.json.replaced === true };
        }
        if (permanentResultRejection(reply.status) && task.deliveryMode !== "minimal") {
          // Preserve exact evidence, without credentials or staged file bytes, before changing delivery.
          yield* retainRejectedReceipt(
            stored,
            { ...task, outcome: task.outcome! },
            reply.status,
            now,
          );
          yield* saveTask({
            ...task,
            deliveryMode: "minimal",
            minimalResult: minimalTaskResult({ ...task, outcome: task.outcome! }),
          });
          reply = yield* deliver(stored, { ...task, outcome: task.outcome! }, task.minimalResult);
          if (reply === null) continue;
          if (yield* handleRejection(stored, reply))
            return { ...stored, active: false, replaced: reply.json.replaced === true };
        }
        if (
          reply.status === 200 ||
          reply.status === 409 ||
          (task.deliveryMode === "minimal" && permanentResultRejection(reply.status))
        ) {
          if (permanentResultRejection(reply.status))
            stored = {
              ...stored,
              deliveryWarning: {
                title: task.title,
                threadId: task.threadId,
                status: reply.status,
              },
            };
          stored = { ...stored, held: stored.held.filter((item) => item.taskId !== task.taskId) };
          yield* writeStored(stored);
        }
      }
      return stored;
    });

  const readBinding = (stored: Stored, taskId: string) =>
    secrets
      .get(bindingKey(stored, taskId))
      .pipe(
        Effect.flatMap((raw) =>
          Option.isNone(raw)
            ? Effect.succeed(null)
            : decodeBinding(new TextDecoder().decode(raw.value)),
        ),
      );

  /** Bindings outlive the active pairing and result delivery, scoped to this API and owner. */
  const bindTask = (stored: Stored, task: typeof Held.Type, projectId: string) =>
    Effect.gen(function* () {
      const existing = yield* readBinding(stored, task.taskId);
      if (existing) {
        if (
          existing.threadId !== task.threadId ||
          existing.claimId !== task.claimId ||
          existing.deviceId !== deviceId ||
          existing.projectId !== projectId
        )
          return yield* failure(
            "This task is already bound to another execution. Nothing was replayed.",
          );
        return;
      }
      const json = yield* encodeBinding({
        taskId: task.taskId,
        claimId: task.claimId,
        threadId: task.threadId,
        deviceId,
        projectId,
      });
      yield* secrets.create(bindingKey(stored, task.taskId), new TextEncoder().encode(json));
    });

  const migrateHeldBindings = (initial: Stored) =>
    Effect.gen(function* () {
      const held = [...initial.held];
      let changed = false;
      for (const [index, task] of initial.held.entries()) {
        if (!task.started || task.projectId !== undefined) continue;
        const shell = yield* projections.getThreadShellById(ThreadId.make(task.threadId));
        if (Option.isNone(shell)) continue;
        const projectId = shell.value.projectId;
        yield* bindTask(initial, task, projectId);
        const project = yield* projections.getProjectShellById(projectId);
        const scratch =
          Option.isSome(project) &&
          normalizeProjectPathForComparison(project.value.workspaceRoot) ===
            normalizeProjectPathForComparison(scratchWorkspaceRootFor(path, serverConfig.baseDir));
        const workspaceKey = scratch
          ? `scratch:${task.threadId}`
          : (shell.value.worktreePath ??
            (Option.isSome(project) ? project.value.workspaceRoot : undefined));
        held[index] = {
          ...task,
          projectId,
          ...(workspaceKey
            ? {
                workspaceKey: scratch
                  ? workspaceKey
                  : normalizeProjectPathForComparison(workspaceKey),
              }
            : {}),
        };
        changed = true;
      }
      const stored = changed ? { ...initial, held } : initial;
      if (changed) yield* writeStored(stored);
      return stored;
    });

  const enqueueTask = (stored: Stored, task: typeof ClaimedTask.Type) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      let held: typeof Held.Type = {
        taskId: task.taskId,
        claimId: task.claimId,
        ...(task.progressVersion === 1 ? { progressVersion: 1 as const } : {}),
        title: task.title,
        threadId: yield* crypto.randomUUIDv4,
        messageId: yield* crypto.randomUUIDv4,
        claimedAt: isoAt(now),
        started: false,
        outcome: null,
        assignment: task,
        projectId: stored.projectId,
        turnCommandId: yield* crypto.randomUUIDv4,
        createCommandId: yield* crypto.randomUUIDv4,
      };
      let reason: string | null = null;
      const duplicate = yield* readBinding(stored, task.taskId);
      if (duplicate) reason = "This task already has a Harness thread. Nothing was replayed.";
      if (task.operation !== undefined) {
        const operation = yield* decodeFollowupOperation(task.operation).pipe(Effect.option);
        if (Option.isNone(operation)) reason = "This task operation is not supported. Nothing ran.";
        else {
          const source = yield* readBinding(stored, operation.value.parentTaskId);
          if (!source)
            reason = "The source task has no saved thread on this computer. Nothing ran.";
          else if (source.deviceId !== deviceId)
            reason = "The source task belongs to another computer. Nothing ran.";
          else {
            const thread = yield* projections.getThreadShellById(ThreadId.make(source.threadId));
            if (Option.isNone(thread))
              reason = "The source task's Harness thread no longer exists. Nothing ran.";
            else
              held = {
                ...held,
                threadId: source.threadId,
                projectId: source.projectId,
                outputId: held.messageId,
              };
          }
        }
      }
      const project = yield* projections.getProjectShellById(ProjectId.make(held.projectId!));
      if (Option.isNone(project)) reason ??= PROJECT_GONE;
      else {
        const scratch =
          normalizeProjectPathForComparison(project.value.workspaceRoot) ===
          normalizeProjectPathForComparison(scratchWorkspaceRootFor(path, serverConfig.baseDir));
        const thread =
          task.operation === undefined
            ? null
            : Option.getOrNull(yield* projections.getThreadShellById(ThreadId.make(held.threadId)));
        held = {
          ...held,
          workspaceKey: scratch
            ? `scratch:${held.threadId}`
            : normalizeProjectPathForComparison(
                thread?.worktreePath ?? project.value.workspaceRoot,
              ),
        };
      }
      if (reason)
        held = { ...held, assignment: undefined, outcome: { status: "failed", result: reason } };
      const next = { ...stored, held: [...stored.held, held] };
      yield* writeStored(next);
      return next;
    });

  /** Dispatch one persisted assignment. A followup retains its thread's runtime and workspace. */
  const startHeld = (stored: Stored, original: typeof Held.Type) =>
    Effect.gen(function* () {
      const task = original.assignment!;
      let held = original;
      let next = stored;
      const save = (updated: typeof held) =>
        Effect.gen(function* () {
          next = {
            ...next,
            held: next.held.map((item) => (item.taskId === held.taskId ? updated : item)),
          };
          yield* writeStored(next);
          held = updated;
        });
      const started = yield* Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const projectId = ProjectId.make(held.projectId ?? stored.projectId);
        const project = yield* projections.getProjectShellById(projectId);
        if (Option.isNone(project)) return yield* Effect.fail(PROJECT_GONE);
        const resolved = resolveProjectSettings(settings, projectId, project.value).settings;
        const createdAt = isoAt(yield* Clock.currentTimeMillis);
        const followup = task.operation !== undefined;
        const source = followup
          ? Option.getOrNull(yield* projections.getThreadShellById(ThreadId.make(held.threadId)))
          : null;
        if (followup && !source)
          return yield* failure("The source thread no longer exists. Nothing ran.");
        const scratchRoot = scratchWorkspaceRootFor(path, serverConfig.baseDir);
        const worktreePath =
          source?.worktreePath ??
          (normalizeProjectPathForComparison(project.value.workspaceRoot) ===
          normalizeProjectPathForComparison(scratchRoot)
            ? yield* claimScratchThreadFolder(scratchRoot, {
                threadId: held.threadId,
                createdAt,
                text: task.title,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              )
            : null);
        const modelSelection: ModelSelection = source?.modelSelection ??
          resolved.defaultModelSelection ??
          settings.defaultModelSelection ?? {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          };
        const outputDirectory = taskOutputDirectory(
          serverConfig.stateDir,
          held.outputId ?? held.threadId,
        );
        yield* Effect.tryPromise(() => prepareTaskOutputDirectory(outputDirectory));
        const attachments: Array<UploadChatAttachment> = [];
        for (const attachment of task.attachments ?? []) {
          if (
            attachment.mimeType.startsWith("image/") &&
            !["image/png", "image/jpeg", "image/webp"].includes(attachment.mimeType)
          )
            return yield* failure("Unsupported task image format.");
          const reply = yield* request(
            HttpClientRequest.get(
              `${stored.apiUrl}/harness/tasks/${task.taskId}/attachments/${attachment.attachmentId}?claimId=${encodeURIComponent(task.claimId)}`,
            ).pipe(HttpClientRequest.setHeaders(workerHeaders(stored))),
          );
          if (reply.status !== 200)
            return yield* failure("Could not retrieve a task attachment. Nothing ran.");
          const downloaded = yield* decodeAttachmentBytes(reply.json);
          if (
            downloaded.attachment.attachmentId !== attachment.attachmentId ||
            downloaded.attachment.sha256 !== attachment.sha256 ||
            downloaded.attachment.mimeType !== attachment.mimeType
          )
            return yield* failure("Task attachment identity changed.");
          const bytes = yield* Effect.try(() =>
            verifiedAttachmentBytes({
              dataBase64: downloaded.dataBase64,
              size: attachment.size,
              sha256: attachment.sha256,
            }),
          );
          if (attachment.mimeType.startsWith("image/")) {
            attachments.push({
              type: "image",
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.size,
              dataUrl: `data:${attachment.mimeType};base64,${downloaded.dataBase64}`,
            });
          } else {
            const file = {
              type: "file" as const,
              id: createPendingAttachmentId(attachmentFileExtension(attachment.name)),
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.size,
            };
            const destination = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: file,
            });
            if (!destination) return yield* failure("Could not store a task document.");
            yield* fileSystem.writeFile(destination, bytes);
            attachments.push(file);
          }
        }

        yield* bindTask(stored, held, projectId);
        if (!followup)
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(held.createCommandId!),
            threadId: ThreadId.make(held.threadId),
            projectId,
            title: taskThreadTitle(task.title),
            modelSelection,
            runtimeMode: resolved.defaultRuntimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath,
            createdAt,
          });
        const turn = yield* normalizeDispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make(held.turnCommandId!),
          threadId: ThreadId.make(held.threadId),
          message: {
            messageId: MessageId.make(held.messageId),
            role: "user",
            text: taskPrompt(task.title, task.prompt, outputDirectory),
            attachments,
          },
          runtimeMode: source?.runtimeMode ?? resolved.defaultRuntimeMode,
          interactionMode: source?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        }).pipe(
          Effect.provideService(WorkspacePaths.WorkspacePaths, workspacePaths),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ServerConfig, serverConfig),
        );
        // After this durable write, never redispatch on restart: reconcile the exact message instead.
        yield* save({
          ...held,
          started: true,
          startedAt: createdAt,
          assignment: undefined,
          ...(source?.latestTurn?.turnId ? { previousTurnId: source.latestTurn.turnId } : {}),
        });
        yield* engine.dispatch(turn);
      }).pipe(
        Effect.as(null),
        Effect.catchCause((cause) => Effect.succeed(cause)),
      );
      if (started !== null && !held.started) {
        const reason =
          Cause.squash(started) === PROJECT_GONE
            ? PROJECT_GONE
            : "Harness could not start this assignment. Nothing ran.";
        yield* save({
          ...held,
          assignment: undefined,
          outcome: { status: "failed", result: reason },
        });
      }
      return next;
    });

  const readProgress = (stored: Stored, now: number) =>
    Effect.gen(function* () {
      const progress = [];
      for (const task of stored.held) {
        const shell = task.started
          ? yield* projections
              .getThreadShellById(ThreadId.make(task.threadId))
              .pipe(Effect.orElseSucceed(() => Option.none()))
          : Option.none();
        const detail = task.started
          ? yield* projections
              .getThreadDetailSnapshot(ThreadId.make(task.threadId), { turnLimit: 2 })
              .pipe(Effect.orElseSucceed(() => Option.none()))
          : Option.none();
        progress.push({
          taskId: task.taskId,
          claimId: task.claimId,
          progress: botTaskSnapshot(
            task,
            { deviceId, projectId: task.projectId ?? stored.projectId, observedAt: isoAt(now) },
            Option.getOrNull(shell),
            Option.getOrNull(detail)?.thread ?? null,
          ),
        });
      }
      yield* Ref.set(snapshots, progress);
      return progress;
    });

  const startPending = (initial: Stored, now: number) =>
    Effect.gen(function* () {
      let stored = initial;
      const target = (yield* settingsService.getSettings).botTaskMaxParallel;
      let launches = 0;
      for (const original of initial.held) {
        if (!original.assignment || original.started || original.outcome !== null) continue;
        const progress = yield* readProgress(stored, now);
        if (
          progress.filter(
            (item) =>
              stored.held.some(
                (task) => task.taskId === item.taskId && task.started && task.outcome === null,
              ) && consumesBotLaunchSlot(item.progress),
          ).length >= target ||
          launches >= MAX_CLAIMS_PER_PASS
        )
          break;
        const sameWorkspace = stored.held.some(
          (task) =>
            task.taskId !== original.taskId &&
            task.started &&
            task.outcome === null &&
            (task.threadId === original.threadId ||
              task.workspaceKey === original.workspaceKey ||
              (task.workspaceKey === undefined &&
                !original.workspaceKey?.startsWith("scratch:") &&
                (task.projectId ?? stored.projectId) === original.projectId)),
        );
        if (sameWorkspace) continue;
        if (original.assignment.operation !== undefined) {
          const shell = yield* projections.getThreadShellById(ThreadId.make(original.threadId));
          if (
            Option.isSome(shell) &&
            (shell.value.session?.status === "running" ||
              shell.value.session?.status === "starting" ||
              shell.value.hasPendingApprovals ||
              shell.value.hasPendingUserInput ||
              shell.value.latestTurn?.state === "running")
          )
            continue;
        }
        stored = yield* startHeld(stored, original);
        launches++;
      }
      return stored;
    });

  const stopClaiming = (stored: Stored, replaced: boolean, message: string) =>
    Effect.gen(function* () {
      yield* writeStored(
        stored.held.length || stored.deliveryWarning
          ? { ...stored, active: false, replaced }
          : null,
      );
      yield* note({ state: null, message, lastCheckInAt: null });
    });

  /** Handles answers that mean this computer no longer runs tasks. Returns true when it stopped. */
  const handleRejection = (stored: Stored, reply: Reply) =>
    reply.status !== 401
      ? Effect.succeed(false)
      : stopClaiming(
          stored,
          reply.json.replaced === true,
          reply.json.replaced === true
            ? "Another computer now runs your TritonAI Bot tasks."
            : "TritonAI Bot no longer recognizes this computer. Choose Allow to run tasks here again.",
        ).pipe(Effect.as(true));

  const pass = Effect.gen(function* () {
    const saved = yield* readStored;
    if (!saved) return;
    const initial = yield* migrateHeldBindings(saved);
    const now = yield* Clock.currentTimeMillis;
    let reachable = true;
    const rejectedProgress = new Map<string, string>();
    // Publish terminal progress before final delivery removes its active journal entry.
    if (initial.active) {
      const publishable = new Set(
        initial.held.filter((task) => task.progressVersion === 1).map((task) => task.taskId),
      );
      const tasks = (yield* readProgress(initial, now)).filter((task) =>
        publishable.has(task.taskId),
      );
      const reply = yield* post(`${initial.apiUrl}/harness/heartbeat`, workerHeaders(initial), {
        capabilities: BOT_TASK_CAPABILITIES,
        tasks,
      }).pipe(Effect.option);
      if (Option.isSome(reply) && (yield* handleRejection(initial, reply.value))) {
        const stopped = yield* readStored;
        if (stopped) yield* settleHeld(stopped, now);
        return;
      }
      reachable = Option.isSome(reply) && reply.value.status === 200;
      if (reachable && Option.isSome(reply) && reply.value.json.tasks !== undefined) {
        const acknowledgements = Array.isArray(reply.value.json.tasks)
          ? reply.value.json.tasks
          : [];
        for (const task of tasks) {
          const ack: unknown = acknowledgements.find(
            (value: unknown) =>
              typeof value === "object" &&
              value !== null &&
              "taskId" in value &&
              value.taskId === task.taskId,
          );
          if (
            typeof ack !== "object" ||
            ack === null ||
            !("accepted" in ack) ||
            ack.accepted !== true
          ) {
            const reason =
              typeof ack === "object" &&
              ack !== null &&
              "reason" in ack &&
              typeof ack.reason === "string"
                ? ack.reason.slice(0, 200)
                : "No valid progress acknowledgement";
            rejectedProgress.set(task.taskId, reason);
          }
        }
      }
      yield* note(
        reachable
          ? { state: "idle", message: null, lastCheckInAt: isoAt(now), lastCheckInMs: now }
          : { state: "error", message: "Could not reach TritonAI Bot. Retrying." },
      );
    }
    let stored = yield* settleHeld(initial, now);
    if (!stored.active) {
      if (!stored.held.length && !stored.deliveryWarning) yield* writeStored(null);
      return;
    }
    if (!reachable) return;
    const rejected = stored.held.filter((task) => rejectedProgress.has(task.taskId));
    if (rejected.length)
      return yield* note({
        state: "error",
        message: `Your Bot could not accept progress for ${rejected.map((task) => `“${taskThreadTitle(task.title)}”: ${rejectedProgress.get(task.taskId)}`).join("; ")}. Existing work is retained. New assignments wait until progress sync recovers.`,
      });
    stored = yield* startPending(stored, now);
    const run = yield* Ref.get(status);
    if (now - run.lastClaimMs < CLAIM_INTERVAL_MS || stored.held.length >= MAX_HELD_TASKS) return;
    if (!(yield* projectExists(stored.projectId)))
      return yield* note({
        state: "error",
        message: "Choose a project for TritonAI Bot tasks in Settings.",
      });
    yield* note({ lastClaimMs: now });
    const target = (yield* settingsService.getSettings).botTaskMaxParallel;
    for (
      let claims = 0;
      claims < MAX_CLAIMS_PER_PASS && stored.held.length < MAX_HELD_TASKS;
      claims++
    ) {
      const progress = yield* readProgress(stored, now);
      const running = progress.filter(
        (item) =>
          stored.held.some(
            (task) => task.taskId === item.taskId && task.started && task.outcome === null,
          ) && consumesBotLaunchSlot(item.progress),
      ).length;
      if (running >= target) break;
      const reply = yield* post(`${stored.apiUrl}/harness/tasks/claim`, workerHeaders(stored), {
        leaseSeconds: LEASE_SECONDS,
        capabilities: BOT_TASK_CAPABILITIES,
      }).pipe(Effect.option);
      if (Option.isNone(reply) || (reply.value.status !== 200 && reply.value.status !== 401))
        return yield* note({ state: "error", message: "Could not reach TritonAI Bot. Retrying." });
      if (yield* handleRejection(stored, reply.value)) return;
      if (reply.value.json.task === null || reply.value.json.task === undefined) break;
      const task = yield* decodeClaimedTask(reply.value.json.task).pipe(Effect.option);
      if (Option.isNone(task) || task.value.userId !== stored.userId) {
        yield* Effect.logWarning("bot task claim had an unexpected shape");
        break;
      }
      if (stored.held.some((held) => held.taskId === task.value.taskId)) break;
      stored = yield* enqueueTask(stored, task.value);
      stored = yield* startPending(stored, now);
    }
    yield* readProgress(stored, now);
  });

  const tick = locked(pass).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("bot task pass failed", { cause }).pipe(
        Effect.andThen(
          note({ state: "error", message: "TritonAI Bot tasks hit a problem. Retrying." }),
        ),
      ),
    ),
  );

  const allow = (input: ServerBotTaskComputerAllowInput) =>
    locked(
      Effect.gen(function* () {
        const apiUrl = normalizeBotApiUrl(input.apiUrl);
        if (!apiUrl) return yield* failure("TritonAI Bot needs a secure address.");
        if (!(yield* projectExists(input.projectId))) {
          return yield* failure("Choose a project for TritonAI Bot tasks.");
        }
        const previous = yield* readStored.pipe(
          Effect.mapError(() => failure("Could not read this computer's TritonAI Bot settings.")),
        );
        if (previous && previous.apiUrl !== apiUrl && previous.held.length) {
          return yield* failure(
            "This computer still holds results for its previous bot. Let them finish delivery before choosing another service.",
          );
        }
        if (previous?.held.length) {
          // Check the authenticated account before replacing its cloud pairing.
          const identity = yield* request(
            HttpClientRequest.get(`${apiUrl}/me`).pipe(
              HttpClientRequest.setHeader("authorization", `Bearer ${input.ownerToken}`),
            ),
          ).pipe(Effect.mapError(() => failure("Could not confirm your TritonAI Bot account.")));
          if (identity.status === 401) {
            return yield* failure(
              "Your TritonAI Bot sign-in expired. Sign in again, then choose Allow.",
            );
          }
          const owner = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              user: Schema.Struct({ userId: Schema.String.check(Schema.isMinLength(1)) }),
            }),
          )(identity.json).pipe(Effect.option);
          if (identity.status !== 200 || Option.isNone(owner)) {
            return yield* failure("Could not confirm your TritonAI Bot account.");
          }
          if (previous.userId !== owner.value.user.userId) {
            return yield* failure(
              "This computer still holds results for another account. Sign back into that account and finish delivery before changing accounts.",
            );
          }
        }
        const reply = yield* post(
          `${apiUrl}/harness/pairing`,
          { authorization: `Bearer ${input.ownerToken}` },
          { device: { deviceId, deviceName, platform } },
        ).pipe(
          Effect.mapError(() => failure("Could not reach TritonAI Bot. Check your connection.")),
        );
        if (reply.status === 401) {
          return yield* failure(
            "Your TritonAI Bot sign-in expired. Sign in again, then choose Allow.",
          );
        }
        const token = reply.json.harnessToken,
          userId = reply.json.userId;
        if (reply.status !== 200 || typeof token !== "string" || typeof userId !== "string") {
          return yield* failure(replyError(reply, "TritonAI Bot did not accept this computer."));
        }
        // Results this computer still holds stay deliverable: the new token is current and each claim ID proves its task.
        if (previous && previous.userId !== userId && previous.held.length) {
          return yield* failure(
            "This computer still holds results for another account. Sign back into that account and finish delivery before changing accounts.",
          );
        }
        const held =
          previous && previous.apiUrl === apiUrl && previous.userId === userId ? previous.held : [];
        yield* writeStored({
          version: 1,
          apiUrl,
          userId,
          token,
          projectId: input.projectId,
          active: true,
          replaced: false,
          held,
          ...(previous?.apiUrl === apiUrl && previous.userId === userId && previous.deliveryWarning
            ? { deliveryWarning: previous.deliveryWarning }
            : {}),
        }).pipe(
          Effect.mapError(() => failure("Could not save this computer's TritonAI Bot pairing.")),
        );
        yield* note({ state: "idle", message: null, lastCheckInMs: 0, lastClaimMs: 0 });
      }),
    ).pipe(Effect.andThen(tick), Effect.andThen(getStatus));

  const stop = (input: ServerBotTaskComputerStopInput) =>
    locked(
      Effect.gen(function* () {
        const stored = yield* readStored.pipe(
          Effect.mapError(() => failure("Could not read this computer's TritonAI Bot settings.")),
        );
        if (!stored) return;
        let message: string | null = null;
        if (
          stored.active &&
          input.ownerToken &&
          normalizeBotApiUrl(input.apiUrl ?? "") === stored.apiUrl
        ) {
          const reply = yield* post(
            `${stored.apiUrl}/harness/pairing/revoke`,
            { authorization: `Bearer ${input.ownerToken}` },
            { deviceId },
          ).pipe(Effect.option);
          // 409 means another computer already took over, which is what stopping wants.
          if (Option.isNone(reply) || (reply.value.status !== 200 && reply.value.status !== 409)) {
            message =
              "Stopped here, but TritonAI Bot could not be told. It will show this computer offline.";
          }
        }
        yield* writeStored(
          stored.held.length || stored.deliveryWarning
            ? { ...stored, active: false, replaced: false }
            : null,
        ).pipe(Effect.mapError(() => failure("Could not stop running TritonAI Bot tasks here.")));
        yield* note({ state: null, message, lastCheckInAt: null, lastCheckInMs: 0 });
      }),
    ).pipe(Effect.andThen(getStatus));

  const setProject = (input: ServerBotTaskComputerProjectInput) =>
    locked(
      Effect.gen(function* () {
        if (!(yield* projectExists(input.projectId)))
          return yield* failure("That project no longer exists.");
        const stored = yield* readStored.pipe(
          Effect.mapError(() => failure("Could not read this computer's TritonAI Bot settings.")),
        );
        if (!stored) return yield* failure("Choose Allow before picking a project.");
        yield* writeStored({ ...stored, projectId: input.projectId }).pipe(
          Effect.mapError(() => failure("Could not save the project.")),
        );
        yield* note({ message: null });
      }),
    ).pipe(Effect.andThen(getStatus));

  return BotTaskComputer.of({ getStatus, allow, stop, setProject, tick });
});

/** Checks in, delivers and claims every ten seconds once the server is ready. */
export const layer = Layer.effect(
  BotTaskComputer,
  Effect.gen(function* () {
    const service = yield* make;
    yield* forkParked(
      Effect.sleep(STARTUP_DELAY).pipe(
        Effect.andThen(service.tick.pipe(Effect.repeat(Schedule.spaced(TICK_INTERVAL)))),
      ),
    );
    return service;
  }),
);
