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
  type ChatAttachment,
  ChatAttachmentId,
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
import {
  Architecture as HostProcessArchitecture,
  Platform as HostProcessPlatform,
} from "@t3tools/shared/HostProcess";
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
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  attachmentFileExtension,
  createPendingAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as BotTaskRuntime from "./BotTaskRuntime.ts";
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
// A 4 MiB attachment travels as up to 5.6 MiB of JSON, in either direction.
const TRANSFER_TIMEOUT = Duration.minutes(2);
const TRANSFER_RETRY = "Task attachment transfer will retry before execution.";
const transferRetryDelay = (attempt: number) =>
  Math.min(30 * 60_000, 30_000 * 2 ** Math.min(attempt - 1, 16));
/** Retry uploads for one day after capturing the completed turn, then report the missing files. */
const OUTPUT_RETRY_WINDOW_MS = 24 * 3_600_000;
/** Input retries must finish well inside the original two-hour claim. */
const INPUT_RETRY_WINDOW_MS = 30 * 60_000;
const INPUT_RETRY_EXPIRED =
  "The file download retry window ended. Nothing ran. Ask your bot to try this assignment again.";
const PROJECT_GONE = "The project for TritonAI Bot tasks no longer exists.";
const WORKSPACE_CHANGED = "The assignment workspace changed before dispatch.";

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
  project: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      workspaceRoot: Schema.String,
      deviceId: Schema.String,
    }),
  ),
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
const encodeProjectCatalog = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ id: Schema.String, title: Schema.String, workspaceRoot: Schema.String }),
    ),
  ),
);

const Binding = Schema.Struct({
  taskId: Schema.String,
  claimId: Schema.String,
  threadId: Schema.String,
  deviceId: Schema.String,
  projectId: Schema.String,
  workspaceKey: Schema.optional(Schema.String),
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
  /** Allocated scratch folder, retained if dispatch must wait for a later pass. */
  executionWorkspacePath: Schema.optional(Schema.String),
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
  transferFailures: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nextTransferAt: Schema.optional(Schema.Number),
  inputRetryUntil: Schema.optional(Schema.Number),
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
  const engine = yield* BotTaskRuntime.BotTaskRuntime;
  const projections = engine;
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

  const request = (input: HttpClientRequest.HttpClientRequest, timeout = REQUEST_TIMEOUT) =>
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
      Effect.timeout(timeout),
    );
  const post = (
    url: string,
    headers: Record<string, string>,
    body: unknown,
    timeout = REQUEST_TIMEOUT,
  ) =>
    request(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
      timeout,
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
  const retainRejectedReceipt = Effect.fn("BotTaskComputer.retainRejectedReceipt")(function* (
    stored: Stored,
    task: HeldTask & { readonly outcome: TaskOutcome },
    rejectedStatus: typeof PermanentResultRejection.Type,
    now: number,
  ) {
    const key = recoveryReceiptKey(stored, task);
    const validateExisting = Effect.fn("BotTaskComputer.validateExisting")(function* (
      bytes: Uint8Array,
    ) {
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

  const settleHeld = Effect.fn("BotTaskComputer.settleHeld")(function* (
    initial: Stored,
    now: number,
  ) {
    let stored = initial;
    tasks: for (const original of initial.held) {
      let task = original;
      const saveTask = Effect.fn("BotTaskComputer.saveTask")(function* (next: typeof task) {
        const nextStored = {
          ...stored,
          held: stored.held.map((item) => (item.taskId === next.taskId ? next : item)),
        };
        yield* writeStored(nextStored);
        stored = nextStored;
        task = next;
      });
      if (task.outcome === null) {
        // Only active pairings may keep a definitively unstarted assignment queued.
        // started:true includes an uncertain dispatch acknowledgement and is never replayed.
        if (!task.started && task.assignment && stored.active) continue;
        const thread = task.started
          ? yield* projections
              .getThreadDetailById(ThreadId.make(task.threadId), { messageId: task.messageId })
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
          assignment: undefined,
          outcome,
          pendingOutputs: outputs.files,
          outputRetryUntil: now + OUTPUT_RETRY_WINDOW_MS,
        });
      }
      // Existing journals get one durable deadline; restarting never resets the retry window.
      if (task.pendingOutputs?.length && task.outputRetryUntil === undefined)
        yield* saveTask({ ...task, outputRetryUntil: now + OUTPUT_RETRY_WINDOW_MS });
      const deferTransfer = Effect.gen(function* () {
        const transferFailures = (task.transferFailures ?? 0) + 1;
        yield* saveTask({
          ...task,
          transferFailures,
          nextTransferAt: (yield* Clock.currentTimeMillis) + transferRetryDelay(transferFailures),
        });
      });
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
        if (now < (task.nextTransferAt ?? 0)) continue tasks;
        const reply = yield* post(
          `${stored.apiUrl}/harness/tasks/${task.taskId}/artifacts`,
          workerHeaders(stored),
          { claimId: task.claimId, ...file },
          TRANSFER_TIMEOUT,
        ).pipe(Effect.option);
        if (Option.isNone(reply)) {
          yield* deferTransfer;
          continue tasks;
        }
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
        if (reply.value.status !== 200) {
          yield* deferTransfer;
          continue tasks;
        }
        const metadata = yield* decodeAttachmentMetadata(reply.value.json.attachment).pipe(
          Effect.option,
        );
        if (Option.isNone(metadata)) {
          yield* deferTransfer;
          continue tasks;
        }
        const attachment = metadata.value;
        // Persist each receipt before proceeding. If its acknowledgement or journal
        // write is lost, the service's task/content-scoped ID settles an identical retry.
        yield* saveTask({
          ...task,
          pendingOutputs: task.pendingOutputs.slice(1),
          transferFailures: undefined,
          nextTransferAt: undefined,
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
  const bindTask = Effect.fn("BotTaskComputer.bindTask")(function* (
    stored: Stored,
    task: typeof Held.Type,
    projectId: string,
  ) {
    const existing = yield* readBinding(stored, task.taskId);
    if (existing) {
      if (
        existing.threadId !== task.threadId ||
        existing.claimId !== task.claimId ||
        existing.deviceId !== deviceId ||
        existing.projectId !== projectId ||
        (existing.workspaceKey !== undefined &&
          task.workspaceKey !== undefined &&
          existing.workspaceKey !== task.workspaceKey)
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
      ...(task.workspaceKey ? { workspaceKey: task.workspaceKey } : {}),
    });
    yield* secrets.create(bindingKey(stored, task.taskId), new TextEncoder().encode(json));
  });

  const migrateHeldBindings = Effect.fn("BotTaskComputer.migrateHeldBindings")(function* (
    initial: Stored,
  ) {
    const held = [...initial.held];
    let changed = false;
    for (const [index, task] of initial.held.entries()) {
      if (
        !task.started ||
        (task.projectId !== undefined && !task.workspaceKey?.startsWith("scratch:"))
      )
        continue;
      const shell = yield* projections.getThreadShellById(ThreadId.make(task.threadId));
      if (Option.isNone(shell)) continue;
      const projectId = ProjectId.make(task.projectId ?? shell.value.projectId);
      if (task.projectId === undefined) yield* bindTask(initial, task, projectId);
      const project = yield* projections.getProjectShellById(projectId);
      const workspacePath =
        shell.value.worktreePath ??
        (Option.isSome(project) ? project.value.workspaceRoot : undefined);
      held[index] = {
        ...task,
        projectId,
        ...(workspacePath
          ? {
              workspaceKey: normalizeProjectPathForComparison(workspacePath),
            }
          : {}),
      };
      changed = true;
    }
    const stored = changed ? { ...initial, held } : initial;
    if (changed) yield* writeStored(stored);
    return stored;
  });

  const enqueueTask = Effect.fn("BotTaskComputer.enqueueTask")(function* (
    stored: Stored,
    task: typeof ClaimedTask.Type,
  ) {
    const now = yield* Clock.currentTimeMillis;
    let held: typeof Held.Type = {
      taskId: task.taskId,
      claimId: task.claimId,
      ...(task.progressVersion === 1 ? { progressVersion: 1 as const } : {}),
      title: task.title,
      threadId: yield* crypto.randomUUIDv4(),
      messageId: yield* crypto.randomUUIDv4(),
      claimedAt: isoAt(now),
      started: false,
      outcome: null,
      assignment: task,
      projectId: task.project?.id ?? stored.projectId,
      turnCommandId: yield* crypto.randomUUIDv4(),
      createCommandId: yield* crypto.randomUUIDv4(),
    };
    let reason: string | null =
      task.project && task.project.deviceId !== deviceId
        ? "The selected project belongs to another task computer. Nothing ran."
        : null;
    let sourceWorkspaceKey: string | undefined;
    const duplicate = yield* readBinding(stored, task.taskId);
    if (duplicate) reason = "This task already has a Harness thread. Nothing was replayed.";
    if (task.operation !== undefined) {
      const operation = yield* decodeFollowupOperation(task.operation).pipe(Effect.option);
      if (Option.isNone(operation)) reason = "This task operation is not supported. Nothing ran.";
      else {
        const source = yield* readBinding(stored, operation.value.parentTaskId);
        if (!source) reason = "The source task has no saved thread on this computer. Nothing ran.";
        else if (source.deviceId !== deviceId)
          reason = "The source task belongs to another computer. Nothing ran.";
        else {
          sourceWorkspaceKey = source.workspaceKey;
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
      if (
        task.project &&
        normalizeProjectPathForComparison(task.project.workspaceRoot) !==
          normalizeProjectPathForComparison(project.value.workspaceRoot)
      )
        reason ??=
          "The selected project folder changed after the assignment was reviewed. Nothing ran.";
      const scratch =
        normalizeProjectPathForComparison(project.value.workspaceRoot) ===
        normalizeProjectPathForComparison(scratchWorkspaceRootFor(path, serverConfig.baseDir));
      const thread =
        task.operation === undefined
          ? null
          : Option.getOrNull(yield* projections.getThreadShellById(ThreadId.make(held.threadId)));
      held = {
        ...held,
        workspaceKey:
          scratch && !thread?.worktreePath
            ? `scratch:${held.threadId}`
            : normalizeProjectPathForComparison(
                thread?.worktreePath ?? project.value.workspaceRoot,
              ),
      };
    }
    if (sourceWorkspaceKey !== undefined && sourceWorkspaceKey !== held.workspaceKey)
      reason ??= "The source thread folder changed since its original assignment. Nothing ran.";
    if (reason)
      held = { ...held, assignment: undefined, outcome: { status: "failed", result: reason } };
    const next = { ...stored, held: [...stored.held, held] };
    yield* writeStored(next);
    return next;
  });

  const executionWorkspaceKey = Effect.fn("BotTaskComputer.executionWorkspaceKey")(function* (
    task: typeof Held.Type,
    fallbackProjectId: string,
  ) {
    const project = yield* projections.getProjectShellById(
      ProjectId.make(task.projectId ?? fallbackProjectId),
    );
    if (Option.isNone(project)) return null;
    const source = yield* projections.getThreadShellById(ThreadId.make(task.threadId));
    if (Option.isSome(source) && source.value.worktreePath !== null)
      return normalizeProjectPathForComparison(source.value.worktreePath);
    const projectRoot = normalizeProjectPathForComparison(project.value.workspaceRoot);
    if (task.assignment?.operation !== undefined) return Option.isSome(source) ? projectRoot : null;
    const scratchRoot = normalizeProjectPathForComparison(
      scratchWorkspaceRootFor(path, serverConfig.baseDir),
    );
    return projectRoot === scratchRoot
      ? task.executionWorkspacePath
        ? normalizeProjectPathForComparison(task.executionWorkspacePath)
        : `scratch:${task.threadId}`
      : projectRoot;
  });

  const verifyExecutionWorkspace = Effect.fn("BotTaskComputer.verifyExecutionWorkspace")(function* (
    task: typeof Held.Type,
    fallbackProjectId: string,
  ) {
    const currentKey = yield* executionWorkspaceKey(task, fallbackProjectId);
    if (currentKey !== null && currentKey !== task.workspaceKey)
      return yield* Effect.fail(WORKSPACE_CHANGED);
  });

  /** Dispatch one persisted assignment. Followups retain their thread and workspace in Auto mode. */
  const startHeld = Effect.fn("BotTaskComputer.startHeld")(function* (
    stored: Stored,
    original: typeof Held.Type,
  ) {
    const task = original.assignment!;
    let held = original;
    let next = stored;
    const save = Effect.fn("BotTaskComputer.save")(function* (updated: typeof held) {
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
      if (
        task.project &&
        normalizeProjectPathForComparison(task.project.workspaceRoot) !==
          normalizeProjectPathForComparison(project.value.workspaceRoot)
      )
        return yield* failure("The reviewed project folder changed. Nothing ran.");
      const resolved = resolveProjectSettings(settings, projectId, project.value).settings;
      const createdAt = isoAt(yield* Clock.currentTimeMillis);
      const followup = task.operation !== undefined;
      const source = Option.getOrNull(
        yield* projections.getThreadShellById(ThreadId.make(held.threadId)),
      );
      if (followup && !source)
        return yield* failure("The source thread no longer exists. Nothing ran.");
      const scratchRoot = scratchWorkspaceRootFor(path, serverConfig.baseDir);
      const worktreePath = source
        ? source.worktreePath
        : normalizeProjectPathForComparison(project.value.workspaceRoot) ===
            normalizeProjectPathForComparison(scratchRoot)
          ? (held.executionWorkspacePath ??
            (yield* claimScratchThreadFolder(scratchRoot, {
              threadId: held.threadId,
              createdAt,
              text: task.title,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            )))
          : null;
      if (
        !followup &&
        worktreePath !== null &&
        held.workspaceKey !== normalizeProjectPathForComparison(worktreePath)
      )
        yield* save({
          ...held,
          executionWorkspacePath: worktreePath,
          workspaceKey: normalizeProjectPathForComparison(worktreePath),
        });
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
      const attachments: Array<ChatAttachment> = [];
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
          TRANSFER_TIMEOUT,
        ).pipe(Effect.mapError(() => TRANSFER_RETRY));
        if ([408, 425, 429].includes(reply.status) || reply.status >= 500)
          return yield* Effect.fail(TRANSFER_RETRY);
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
        const file = {
          type: attachment.mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
          id: ChatAttachmentId.make(
            createPendingAttachmentId(attachmentFileExtension(attachment.name)),
          ),
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.size,
        };
        const destination = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment: file,
        });
        if (!destination) return yield* failure("Could not store a task attachment.");
        yield* fileSystem.writeFile(destination, bytes);
        attachments.push(file);
      }

      yield* verifyExecutionWorkspace(held, stored.projectId);
      yield* bindTask(stored, held, projectId);
      if (!followup)
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(held.createCommandId!),
          threadId: ThreadId.make(held.threadId),
          projectId,
          title: taskThreadTitle(task.title),
          modelSelection,
          runtimeMode: "auto",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath,
          createdBy: "agent",
          creationSource: "server",
        });
      if (source && source.runtimeMode !== "auto")
        yield* engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`${held.turnCommandId}:mode`),
          threadId: ThreadId.make(held.threadId),
          runtimeMode: "auto",
        });
      const turn = {
        type: "message.dispatch" as const,
        commandId: CommandId.make(held.turnCommandId!),
        threadId: ThreadId.make(held.threadId),
        messageId: MessageId.make(held.messageId),
        text: taskPrompt(task.title, task.prompt, outputDirectory),
        attachments,
        dispatchMode: { type: "queue_after_active" as const },
        createdBy: "agent" as const,
        creationSource: "server" as const,
      };
      yield* verifyExecutionWorkspace(held, stored.projectId);
      // After this durable write, never redispatch on restart: reconcile the exact message instead.
      yield* save({
        ...held,
        started: true,
        startedAt: createdAt,
        assignment: undefined,
        nextTransferAt: undefined,
        transferFailures: undefined,
        inputRetryUntil: undefined,
        ...(source?.latestTurn?.turnId ? { previousTurnId: source.latestTurn.turnId } : {}),
      });
      yield* engine.dispatch(turn);
    }).pipe(
      Effect.as(null),
      Effect.catchCause((cause) => Effect.succeed(cause)),
    );
    if (started !== null && !held.started) {
      // Re-evaluate the new folder and conflicts on the next pass. No turn was requested.
      if (Cause.squash(started) === WORKSPACE_CHANGED && task.operation === undefined) return next;
      if (Cause.squash(started) === TRANSFER_RETRY) {
        const now = yield* Clock.currentTimeMillis;
        const inputRetryUntil = Math.min(
          held.inputRetryUntil ?? now + INPUT_RETRY_WINDOW_MS,
          Date.parse(held.claimedAt) + LEASE_SECONDS * 1000,
        );
        if (now < inputRetryUntil) {
          const transferFailures = (held.transferFailures ?? 0) + 1;
          yield* save({
            ...held,
            transferFailures,
            inputRetryUntil,
            nextTransferAt: now + transferRetryDelay(transferFailures),
          });
          return next;
        }
      }
      const reason =
        Cause.squash(started) === PROJECT_GONE
          ? PROJECT_GONE
          : Cause.squash(started) === WORKSPACE_CHANGED
            ? "The source thread's workspace changed. Nothing ran."
            : "Harness could not start this assignment. Nothing ran.";
      yield* save({
        ...held,
        assignment: undefined,
        outcome: { status: "failed", result: reason },
      });
    }
    return next;
  });

  const readProgress = Effect.fn("BotTaskComputer.readProgress")(function* (
    stored: Stored,
    now: number,
  ) {
    const progress = [];
    for (const task of stored.held) {
      const shell = task.started
        ? yield* projections
            .getThreadShellById(ThreadId.make(task.threadId))
            .pipe(Effect.orElseSucceed(() => Option.none()))
        : Option.none();
      const detail = task.started
        ? yield* projections
            .getThreadDetailById(ThreadId.make(task.threadId), { messageId: task.messageId })
            .pipe(Effect.orElseSucceed(() => Option.none()))
        : Option.none();
      progress.push({
        taskId: task.taskId,
        claimId: task.claimId,
        progress: botTaskSnapshot(
          task,
          { deviceId, projectId: task.projectId ?? stored.projectId, observedAt: isoAt(now) },
          Option.getOrNull(detail) ?? Option.getOrNull(shell),
          Option.getOrNull(detail),
        ),
      });
    }
    yield* Ref.set(snapshots, progress);
    return progress;
  });

  const startPending = Effect.fn("BotTaskComputer.startPending")(function* (
    initial: Stored,
    now: number,
  ) {
    let stored = initial;
    const target = (yield* settingsService.getSettings).botTaskMaxParallel;
    let launches = 0;
    for (const queued of initial.held) {
      if (
        !queued.assignment ||
        queued.started ||
        queued.outcome !== null ||
        now < (queued.nextTransferAt ?? 0)
      )
        continue;
      const workspaceKey = yield* executionWorkspaceKey(queued, stored.projectId);
      const original =
        queued.assignment.operation === undefined &&
        workspaceKey !== null &&
        workspaceKey !== queued.workspaceKey
          ? { ...queued, workspaceKey }
          : queued;
      if (original !== queued) {
        stored = {
          ...stored,
          held: stored.held.map((task) => (task.taskId === original.taskId ? original : task)),
        };
        yield* writeStored(stored);
      }
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
      if (original.assignment?.operation !== undefined) {
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

  const stopClaiming = Effect.fn("BotTaskComputer.stopClaiming")(function* (
    stored: Stored,
    replaced: boolean,
    message: string,
  ) {
    yield* writeStored(
      stored.held.length || stored.deliveryWarning ? { ...stored, active: false, replaced } : null,
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

  const executionReport = Effect.fn("BotTaskComputer.executionReport")(function* (stored: Stored) {
    const projects = yield* projections.listProjects;
    const current = projects.find((project) => project.id === stored.projectId);
    const settings = yield* settingsService.getSettings;
    const resolved = current
      ? resolveProjectSettings(settings, ProjectId.make(current.id), current).settings
      : settings;
    const selection = resolved.defaultModelSelection ??
      settings.defaultModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };
    const ordered = [...projects].sort(
      (a, b) => Number(b.id === stored.projectId) - Number(a.id === stored.projectId),
    );
    const catalog = ordered.slice(0, 100).map((project) => ({
      id: project.id,
      title: project.title.slice(0, 200),
      workspaceRoot: project.workspaceRoot,
    }));
    // Keep the shared pairing record below DynamoDB's item limit, including progress metadata.
    while (Buffer.byteLength(encodeProjectCatalog(catalog)) > 64_000) catalog.pop();
    return {
      projects: {
        version: 1 as const,
        defaultProjectId: stored.projectId,
        hasMore: projects.length > catalog.length,
        projects: catalog,
      },
      readiness: {
        version: 1 as const,
        runtime: "desktop" as const,
        executor: { task: true, query: false },
        project: { required: true, present: !!current, id: stored.projectId },
        model: {
          configured: !!selection?.model,
          ...(selection ? { provider: selection.instanceId, id: selection.model } : {}),
        },
        permissions: { task: "allow" as const, query: "deny" as const },
        setup: { projectCreation: false },
      },
    };
  });

  const pass = Effect.gen(function* () {
    const saved = yield* readStored;
    if (!saved) return;
    let initial = yield* migrateHeldBindings(saved);
    const now = yield* Clock.currentTimeMillis;
    const held = initial.held.map((task) =>
      !task.started &&
      task.outcome === null &&
      task.inputRetryUntil !== undefined &&
      now >= Math.min(task.inputRetryUntil, Date.parse(task.claimedAt) + LEASE_SECONDS * 1000)
        ? {
            ...task,
            assignment: undefined,
            nextTransferAt: undefined,
            inputRetryUntil: undefined,
            outcome: { status: "failed" as const, result: INPUT_RETRY_EXPIRED },
          }
        : task,
    );
    if (held.some((task, index) => task !== initial.held[index])) {
      // Do this before heartbeat: an expired claim can reject progress, but its
      // never-started failure result must still settle and unblock this worker.
      initial = { ...initial, held };
      yield* writeStored(initial);
    }
    const report = yield* executionReport(initial);
    let reachable = true;
    const rejectedProgress = new Map<string, string>();
    const refusedProgress = new Set<string>();
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
        ...report,
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
            if (
              typeof ack === "object" &&
              ack !== null &&
              "accepted" in ack &&
              ack.accepted === false
            )
              refusedProgress.add(task.taskId);
          }
        }
      }
      yield* note(
        reachable
          ? { state: "idle", message: null, lastCheckInAt: isoAt(now), lastCheckInMs: now }
          : { state: "error", message: "Could not reach TritonAI Bot. Retrying." },
      );
    }
    const heldAfterRefusal = initial.held.map((task) =>
      !task.started && task.outcome === null && refusedProgress.has(task.taskId)
        ? {
            ...task,
            assignment: undefined,
            nextTransferAt: undefined,
            inputRetryUntil: undefined,
            outcome: {
              status: "failed" as const,
              result:
                "Your Bot could not confirm this assignment. Nothing ran. Ask your bot to try again.",
            },
          }
        : task,
    );
    if (heldAfterRefusal.some((task, index) => task !== initial.held[index])) {
      // A refused unstarted assignment can be settled safely. An uncertain dispatch
      // (started:true) and a missing acknowledgement must keep their existing gate.
      initial = { ...initial, held: heldAfterRefusal };
      yield* writeStored(initial);
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
        ...report,
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
).pipe(Layer.provide(BotTaskRuntime.layer));
