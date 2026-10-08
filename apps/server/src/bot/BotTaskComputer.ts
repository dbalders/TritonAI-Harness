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

import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type ModelSelection,
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
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
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
/** The bot counts a computer online for three minutes after it checks in. */
const HEARTBEAT_INTERVAL_MS = 60_000;
/** The longest claim the bot grants; a late result is still accepted after it lapses. */
const LEASE_SECONDS = 7200;
const REQUEST_TIMEOUT = Duration.seconds(15);
const PROJECT_GONE = "The project for TritonAI Bot tasks no longer exists.";

const Outcome = Schema.Struct({
  status: Schema.Literals(["completed", "failed"]),
  result: Schema.String,
});
const Held = Schema.Struct({
  taskId: Schema.String,
  claimId: Schema.String,
  title: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String,
  claimedAt: Schema.String,
  started: Schema.Boolean,
  outcome: Schema.NullOr(Outcome),
});
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
});
type Stored = typeof Stored.Type;
const StoredJson = Schema.fromJsonString(Stored);
const decodeStored = Schema.decodeUnknownEffect(StoredJson);
const encodeStored = Schema.encodeEffect(StoredJson);

const ClaimedTask = Schema.Struct({
  taskId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)),
  userId: Schema.String,
  claimId: Schema.String.check(Schema.isMinLength(1)),
  title: Schema.String,
  prompt: Schema.String,
});
const decodeClaimedTask = Schema.decodeUnknownEffect(ClaimedTask);

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
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
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

  const post = (url: string, headers: Record<string, string>, body: unknown) =>
    httpClient
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
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
    const current = stored?.held.find((task) => task.outcome === null) ?? null;
    const state: ServerBotTaskComputerState = !stored
      ? "off"
      : stored.replaced
        ? "replaced"
        : !stored.active
          ? "off"
          : current
            ? "running"
            : (run.state ?? "idle");
    return {
      state,
      deviceId,
      deviceName,
      apiUrl: stored?.active ? stored.apiUrl : null,
      userId: stored?.userId ?? null,
      projectId: stored?.projectId ?? null,
      currentTask: current
        ? {
            taskId: current.taskId,
            title: taskThreadTitle(current.title),
            threadId: current.started ? current.threadId : null,
            startedAt: current.claimedAt,
          }
        : null,
      lastCheckInAt: stored?.active ? run.lastCheckInAt : null,
      message: run.message,
    } satisfies ServerBotTaskComputerStatus;
  });

  /** Saves the outcome first, so a failed delivery is retried rather than the task rerun. */
  const deliver = (stored: Stored, task: HeldTask & { readonly outcome: TaskOutcome }) =>
    post(`${stored.apiUrl}/harness/results`, workerHeaders(stored), {
      taskId: task.taskId,
      claimId: task.claimId,
      status: task.outcome.status,
      result: task.outcome.result,
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
      for (const task of initial.held) {
        let outcome = task.outcome;
        if (outcome === null) {
          const thread = task.started
            ? yield* projections
                .getThreadDetailById(ThreadId.make(task.threadId), { activityKinds: [] })
                .pipe(Effect.map(Option.getOrNull), Effect.option)
            : Option.some(null);
          // A failed read is not evidence the thread is gone; check again next pass.
          if (Option.isNone(thread)) continue;
          const progress = taskProgress(thread.value, task, now);
          if (progress.kind === "pending") continue;
          outcome = { status: progress.status, result: progress.result };
          stored = {
            ...stored,
            held: stored.held.map((item) =>
              item.taskId === task.taskId ? { ...item, outcome } : item,
            ),
          };
          yield* writeStored(stored);
        }
        const reply = yield* deliver(stored, { ...task, outcome });
        if (reply === null) continue;
        if (yield* handleRejection(stored, reply)) {
          return { ...stored, active: false, replaced: reply.json.replaced === true };
        }
        if (reply.status === 200 || reply.status === 409) {
          stored = { ...stored, held: stored.held.filter((item) => item.taskId !== task.taskId) };
          yield* writeStored(stored);
        }
      }
      return stored;
    });

  /** The thread inherits the project's model and permission defaults, as if the owner started it. */
  const startTask = (stored: Stored, task: typeof ClaimedTask.Type) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const held: HeldTask = {
        taskId: task.taskId,
        claimId: task.claimId,
        title: task.title,
        threadId: yield* crypto.randomUUIDv4,
        messageId: yield* crypto.randomUUIDv4,
        claimedAt: isoAt(now),
        started: false,
        outcome: null,
      };
      let next: Stored = { ...stored, held: [...stored.held, held] };
      yield* writeStored(next);
      const markStarted = () => {
        next = {
          ...next,
          held: next.held.map((item) =>
            item.taskId === held.taskId ? { ...item, started: true } : item,
          ),
        };
        return writeStored(next);
      };
      const started = yield* Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const projectId = ProjectId.make(stored.projectId);
        const project = yield* projections.getProjectShellById(projectId);
        if (Option.isNone(project)) return yield* Effect.fail(PROJECT_GONE);
        const resolved = resolveProjectSettings(settings, projectId, project.value).settings;
        const modelSelection: ModelSelection = resolved.defaultModelSelection ??
          settings.defaultModelSelection ?? {
            instanceId: ProviderInstanceId.make("codex"),
            model: DEFAULT_MODEL,
          };
        const createdAt = isoAt(now);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`bot-task:create:${held.taskId}:${yield* crypto.randomUUIDv4}`),
          threadId: ThreadId.make(held.threadId),
          projectId,
          title: taskThreadTitle(task.title),
          modelSelection,
          runtimeMode: resolved.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        // From here the turn may run, so a restart must wait for the thread rather than call it unstarted.
        yield* markStarted();
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`bot-task:turn:${held.taskId}:${yield* crypto.randomUUIDv4}`),
          threadId: ThreadId.make(held.threadId),
          message: {
            messageId: MessageId.make(held.messageId),
            role: "user",
            text: taskPrompt(task.title, task.prompt),
            attachments: [],
          },
          runtimeMode: resolved.defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        });
      }).pipe(
        Effect.as(null),
        Effect.catchCause((cause) => Effect.succeed(cause)),
      );
      if (started !== null) {
        // Dispatch can persist before its acknowledgement fails. Never report an attempted turn as unstarted.
        if (next.held.find((item) => item.taskId === held.taskId)?.started) return;
        // A rejected command did not run. Report it now rather than waiting for the start grace period.
        yield* Effect.logWarning("bot task could not start", {
          taskId: held.taskId,
          cause: started,
        });
        const reason =
          Cause.squash(started) === PROJECT_GONE
            ? PROJECT_GONE
            : "Harness could not start a thread for it.";
        next = {
          ...next,
          held: next.held.map((item) =>
            item.taskId === held.taskId
              ? {
                  ...item,
                  outcome: { status: "failed" as const, result: `${reason} Nothing ran.` },
                }
              : item,
          ),
        };
        yield* writeStored(next);
      }
    });

  const stopClaiming = (stored: Stored, replaced: boolean, message: string) =>
    Effect.gen(function* () {
      yield* writeStored(stored.held.length ? { ...stored, active: false, replaced } : null);
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
    const initial = yield* readStored;
    if (!initial) return;
    const now = yield* Clock.currentTimeMillis;
    const stored = yield* settleHeld(initial, now);
    if (!stored.active) {
      if (!stored.held.length) yield* writeStored(null);
      return;
    }
    const run = yield* Ref.get(status);
    if (now - run.lastCheckInMs >= HEARTBEAT_INTERVAL_MS) {
      const reply = yield* post(
        `${stored.apiUrl}/harness/heartbeat`,
        workerHeaders(stored),
        {},
      ).pipe(Effect.option);
      if (Option.isNone(reply) || (reply.value.status !== 200 && reply.value.status !== 401)) {
        return yield* note({ state: "error", message: "Could not reach TritonAI Bot. Retrying." });
      }
      if (yield* handleRejection(stored, reply.value)) return;
      yield* note({ state: "idle", message: null, lastCheckInAt: isoAt(now), lastCheckInMs: now });
    }
    if (stored.held.some((task) => task.outcome === null)) return;
    if (now - run.lastClaimMs < CLAIM_INTERVAL_MS) return;
    if (!(yield* projectExists(stored.projectId))) {
      return yield* note({
        state: "error",
        message: "Choose a project for TritonAI Bot tasks in Settings.",
      });
    }
    yield* note({ lastClaimMs: now });
    const reply = yield* post(`${stored.apiUrl}/harness/tasks/claim`, workerHeaders(stored), {
      leaseSeconds: LEASE_SECONDS,
    }).pipe(Effect.option);
    if (Option.isNone(reply) || (reply.value.status !== 200 && reply.value.status !== 401)) {
      return yield* note({ state: "error", message: "Could not reach TritonAI Bot. Retrying." });
    }
    if (yield* handleRejection(stored, reply.value)) return;
    yield* note({ state: "idle", message: null, lastCheckInAt: isoAt(now), lastCheckInMs: now });
    if (reply.value.json.task === null || reply.value.json.task === undefined) return;
    const task = yield* decodeClaimedTask(reply.value.json.task).pipe(Effect.option);
    if (Option.isNone(task) || task.value.userId !== stored.userId) {
      return yield* Effect.logWarning("bot task claim had an unexpected shape");
    }
    yield* startTask(stored, task.value);
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
          stored.held.length ? { ...stored, active: false, replaced: false } : null,
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
