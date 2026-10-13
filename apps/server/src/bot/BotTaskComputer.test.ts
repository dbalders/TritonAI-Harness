// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type {
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { taskOutputDirectory } from "./botTaskFiles.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as BotTaskComputer from "./BotTaskComputer.ts";

const API = "https://bot.example.ucsd.edu";
const START = Date.parse("2026-10-08T06:00:00.000Z");
const PROJECT = "project-1";
const screenshotBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0pEAAAAASUVORK5CYII=",
  "base64",
);
const screenshot = {
  attachmentId: `att_${"a".repeat(64)}`,
  name: "screen.png",
  mimeType: "image/png",
  size: screenshotBytes.length,
  sha256: NodeCrypto.createHash("sha256").update(screenshotBytes).digest("hex"),
};

const documentBytes = Buffer.from("This is the complete original document.");
const document = {
  attachmentId: `att_${"c".repeat(64)}`,
  name: "notes.txt",
  mimeType: "text/plain",
  size: documentBytes.length,
  sha256: NodeCrypto.createHash("sha256").update(documentBytes).digest("hex"),
};

const SavedOutputJournal = Schema.fromJsonString(
  Schema.Struct({
    held: Schema.Array(
      Schema.Struct({
        outcome: Schema.Struct({
          status: Schema.Literals(["completed", "failed"]),
          structuredResult: Schema.optional(
            Schema.Struct({
              artifacts: Schema.Array(Schema.Struct({ label: Schema.String })),
              blockers: Schema.Array(Schema.String),
            }),
          ),
        }),
        pendingOutputs: Schema.Array(
          Schema.Struct({ name: Schema.String, dataBase64: Schema.String }),
        ),
        outputRetryUntil: Schema.optional(Schema.Number),
      }),
    ),
  }),
);

const decodeSavedOutputJournal = Schema.decodeEffect(SavedOutputJournal);
const RecoveryJournalJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeRecoveryJournal = Schema.decodeEffect(RecoveryJournalJson);
const encodeRecoveryJournal = Schema.encodeEffect(RecoveryJournalJson);
const decodeRecoveryHeld = Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown));
const encodeReportedJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const reportWithBlockers = () =>
  `Finished report.\n\`\`\`bot-result\n${encodeReportedJson({ summary: "Finished report", blockers: Array.from({ length: 10 }, (_, index) => `Reported blocker ${index}`) })}\n\`\`\``;
const readRecoveryJournal = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const raw = yield* secrets.get("tritonai-bot-task-computer");
  return yield* decodeRecoveryJournal(new TextDecoder().decode(Option.getOrThrow(raw)));
});
const writeRecoveryJournal = (value: Record<string, unknown>) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const json = yield* encodeRecoveryJournal(value);
    yield* secrets.set("tritonai-bot-task-computer", new TextEncoder().encode(json));
  });
const resultRecoveryKey = (taskId: string) =>
  "tritonai-bot-result-recovery-" +
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([API, "owner@ucsd.edu", taskId, "claim-" + taskId]))
    .digest("hex");
const readResultRecovery = (taskId: string) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const raw = yield* secrets.get(resultRecoveryKey(taskId));
    return yield* decodeRecoveryJournal(new TextDecoder().decode(Option.getOrThrow(raw)));
  });
const appendRecoveredResult = (taskId: string, result: string) =>
  Effect.gen(function* () {
    const state = yield* readRecoveryJournal;
    const held = yield* decodeRecoveryHeld(state.held);
    yield* writeRecoveryJournal({
      ...state,
      held: [
        ...held,
        {
          taskId,
          claimId: `claim-${taskId}`,
          title: taskId,
          threadId: `${taskId}-thread`,
          messageId: `${taskId}-message`,
          claimedAt: "2026-10-08T06:00:00.000Z",
          started: true,
          outcome: { status: "completed", result },
          pendingOutputs: [],
        },
      ],
    });
  });

interface Call {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** The bot's control plane: one current token, a queue of tasks, and recorded results. */
class FakeBot {
  readonly calls: Array<Call> = [];
  readonly results: Array<Record<string, unknown>> = [];
  tasks: Array<{
    taskId: string;
    title: string;
    prompt: string;
    attachments?: Array<typeof screenshot>;
  }> = [];
  corruptAttachment = false;
  artifactStatus = 200;
  artifactStatuses: number[] = [];
  malformedArtifactMetadata = false;
  failArtifactTransport = false;
  loseArtifactReply = false;
  readonly artifactWrites = new Map<string, Record<string, unknown>>();
  current = "token-1";
  replaced = false;
  resultStatus = 200;
  resultStatuses: number[] = [];
  sessionValid = true;
  ownerId = "owner@ucsd.edu";

  handle(path: string, headers: Record<string, string>, body: Record<string, unknown>) {
    this.calls.push({ path, headers, body });
    const worker = headers["x-triton-harness-token"];
    if (path === "/me") {
      return this.sessionValid
        ? { status: 200, json: { user: { userId: this.ownerId } } }
        : { status: 401, json: { error: "Invalid or expired owner session" } };
    }
    if (path === "/harness/pairing") {
      return this.sessionValid
        ? { status: 200, json: { ok: true, userId: this.ownerId, harnessToken: this.current } }
        : { status: 401, json: { ok: false, error: "Invalid or expired owner session" } };
    }
    if (path === "/harness/pairing/revoke")
      return { status: 200, json: { ok: true, taskComputer: null } };
    if (path === "/harness/results") {
      const status = this.resultStatuses.shift() ?? this.resultStatus;
      if (status === 200) this.results.push(body);
      return { status, json: {} };
    }
    if (this.replaced || worker !== this.current) {
      return { status: 401, json: { ok: false, replaced: this.replaced } };
    }
    if (/^\/harness\/tasks\/[^/]+\/attachments\//u.test(path)) {
      const isDocument = path.endsWith(document.attachmentId);
      return {
        status: 200,
        json: {
          attachment: isDocument ? document : screenshot,
          dataBase64: this.corruptAttachment
            ? "Y29ycnVwdA=="
            : (isDocument ? documentBytes : screenshotBytes).toString("base64"),
        },
      };
    }
    if (/^\/harness\/tasks\/[^/]+\/artifacts$/u.test(path)) {
      const status = this.artifactStatuses.shift() ?? this.artifactStatus;
      if (status === 200)
        this.artifactWrites.set(
          JSON.stringify([path, body.name, body.mimeType, body.dataBase64]),
          body,
        );
      const responseLost = this.loseArtifactReply;
      this.loseArtifactReply = false;
      return {
        status: responseLost ? 503 : status,
        json: {
          attachment: {
            attachmentId: this.malformedArtifactMetadata ? "invalid" : `att_${"b".repeat(64)}`,
            name: body.name,
            mimeType: body.mimeType,
            size: Buffer.from(String(body.dataBase64), "base64").length,
            sha256: NodeCrypto.createHash("sha256")
              .update(Buffer.from(String(body.dataBase64), "base64"))
              .digest("hex"),
          },
        },
      };
    }
    if (path === "/harness/heartbeat") return { status: 200, json: { ok: true } };
    if (path === "/harness/tasks/claim") {
      const task = this.tasks.shift();
      return {
        status: 200,
        json: {
          ok: true,
          task: task
            ? { ...task, userId: "owner@ucsd.edu", claimId: `claim-${task.taskId}`, createdAt: "" }
            : null,
        },
      };
    }
    return { status: 404, json: {} };
  }

  layer() {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        this.failArtifactTransport && new URL(request.url).pathname.endsWith("/artifacts")
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: "Synthetic disconnected transport",
                }),
              }),
            )
          : Effect.sync(() => {
              const raw =
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "{}";
              const headers = Object.fromEntries(
                Object.entries(request.headers).map(([key, value]) => [
                  key.toLowerCase(),
                  String(value),
                ]),
              );
              const url = new URL(request.url);
              assert.strictEqual(url.origin, API);
              // @effect-diagnostics-next-line preferSchemaOverJson:off - reads the fake request body.
              const body = JSON.parse(raw) as Record<string, unknown>;
              const reply = this.handle(url.pathname, headers, body);
              return HttpClientResponse.fromWeb(
                request,
                Response.json(reply.json, { status: reply.status }),
              );
            }),
      ),
    );
  }
}

/** Threads created through dispatch, which tests then finish by hand. */
class FakeHarness {
  readonly commands: Array<OrchestrationCommand> = [];
  readonly threads = new Map<string, OrchestrationThread>();
  rejectTurns = false;
  failAfterTurnPersisted = false;

  finish(threadId: string, reply: string, state: "completed" | "error" = "completed") {
    const thread = this.threads.get(threadId)!;
    this.threads.set(threadId, {
      ...thread,
      latestTurn: {
        turnId: "turn-1",
        state,
        requestedAt: "",
        startedAt: "",
        completedAt: "",
        assistantMessageId: null,
      },
      session: {
        status: state === "error" ? "error" : "ready",
        lastError: state === "error" ? "Provider failed" : null,
      },
      messages: [
        ...thread.messages,
        {
          id: "reply-1",
          role: "assistant",
          text: reply,
          streaming: false,
          turnId: "turn-1",
          createdAt: "",
          updatedAt: "",
        },
      ],
    } as unknown as OrchestrationThread);
  }

  layer() {
    const harness = this;
    return Layer.mergeAll(
      Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.suspend(() => {
            if (command.type === "thread.turn.start" && harness.rejectTurns) {
              return Effect.die("rejected");
            }
            harness.commands.push(command);
            if (command.type === "thread.create") {
              harness.threads.set(command.threadId, {
                id: command.threadId,
                title: command.title,
                deletedAt: null,
                latestTurn: null,
                session: null,
                messages: [],
              } as unknown as OrchestrationThread);
            }
            if (command.type === "thread.turn.start") {
              const thread = harness.threads.get(command.threadId)!;
              harness.threads.set(command.threadId, {
                ...thread,
                latestTurn: { turnId: "turn-1", state: "running" },
                session: { status: "running", lastError: null },
                messages: [
                  {
                    id: command.message.messageId,
                    role: "user",
                    text: command.message.text,
                    streaming: false,
                    turnId: null,
                  },
                ],
              } as unknown as OrchestrationThread);
            }
            if (command.type === "thread.turn.start" && harness.failAfterTurnPersisted)
              return Effect.die("acknowledgement unavailable");
            return Effect.succeed({ sequence: harness.commands.length });
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById: (projectId) =>
          Effect.succeed(
            projectId === PROJECT
              ? Option.some({
                  id: PROJECT,
                  title: "Tasks",
                  workspaceRoot: "/tmp/tasks",
                } as unknown as OrchestrationProjectShell)
              : Option.none(),
          ),
        getThreadDetailById: (threadId) =>
          Effect.sync(() => Option.fromNullishOr(harness.threads.get(threadId))),
      }),
    );
  }
}

const services = (bot: FakeBot, harness: FakeHarness) =>
  Layer.effect(BotTaskComputer.BotTaskComputer, BotTaskComputer.make).pipe(
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(bot.layer()),
    Layer.provideMerge(harness.layer()),
    Layer.provideMerge(ServerSettings.layerTest({})),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-task-test-" })),
  );

const allow = (computer: BotTaskComputer.BotTaskComputer["Service"]) =>
  computer.allow({ apiUrl: API, ownerToken: "owner-session", projectId: PROJECT });

it.layer(NodeServices.layer)("BotTaskComputer", (it) => {
  for (const rejection of [400, 403, 404, 405, 409, 410, 412, 413, 414, 415, 422]) {
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      `settles permanent upload ${rejection} per file and continues to the next assignment`,
      () => {
        const bot = new FakeBot(),
          harness = new FakeHarness();
        bot.tasks = [
          { taskId: "permanent", title: "Report", prompt: "Return report" },
          { taskId: "next", title: "Next", prompt: "Next task" },
        ];
        return Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const computer = yield* BotTaskComputer.BotTaskComputer;
          const config = yield* ServerConfig.ServerConfig;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* allow(computer);
          const turn = harness.commands.find((command) => command.type === "thread.turn.start")!;
          const output = taskOutputDirectory(config.stateDir, turn.threadId);
          yield* Effect.tryPromise(() => NodeFSP.writeFile(NodePath.join(output, "a.txt"), "A"));
          yield* Effect.tryPromise(() => NodeFSP.writeFile(NodePath.join(output, "b.txt"), "B"));
          harness.finish(turn.threadId, reportWithBlockers());
          bot.artifactStatuses = [rejection, 200];
          bot.resultStatus = 503;
          yield* TestClock.adjust("61 seconds");
          yield* computer.tick;
          const raw = yield* secrets.get("tritonai-bot-task-computer");
          const saved = yield* decodeSavedOutputJournal(
            new TextDecoder().decode(Option.getOrThrow(raw)),
          );
          assert.lengthOf(saved.held, 1);
          assert.lengthOf(saved.held[0]!.pendingOutputs, 0);
          assert.strictEqual(saved.held[0]!.outcome.status, "completed");
          assert.lengthOf(harness.commands, 2);
          assert.lengthOf(bot.tasks, 1);
          assert.strictEqual(
            yield* Effect.tryPromise(() =>
              NodeFSP.readFile(NodePath.join(output, "a.txt"), "utf8"),
            ),
            "A",
          );
          bot.resultStatus = 200;
          const restarted = yield* BotTaskComputer.make;
          yield* restarted.tick;
          assert.strictEqual(bot.results[0]!.status, "completed");
          assert.include(String(bot.results[0]!.result), "Finished report");
          const evidence = bot.results[0]!.structuredResult as {
            artifacts: Array<{ label: string }>;
            blockers: string[];
          };
          assert.deepEqual(
            evidence.artifacts.map((item) => item.label),
            rejection === 404 ? [] : ["b.txt"],
          );
          assert.lengthOf(evidence.blockers, 10);
          assert.include(
            evidence.blockers[0]!,
            rejection === 404
              ? "does not support downloadable task files"
              : "could not accept output a.txt",
          );
          assert.deepEqual(
            bot.calls
              .filter((call) => call.path.endsWith("/artifacts"))
              .map((call) => call.body.name),
            rejection === 404 ? ["a.txt"] : ["a.txt", "b.txt"],
          );
          assert.strictEqual((yield* restarted.getStatus).currentTask?.taskId, "next");
          assert.lengthOf(harness.commands, 4);
        }).pipe(Effect.provide(services(bot, harness)));
      },
    );
  }

  for (const failureKind of ["unavailable", "malformed", "transport", 408, 425, 429] as const) {
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      `defers ${failureKind} uploads independently and settles a durable retry deadline`,
      () => {
        const bot = new FakeBot(),
          harness = new FakeHarness();
        bot.tasks = [
          { taskId: "deferred", title: "Report", prompt: "Return report" },
          { taskId: "next", title: "Next", prompt: "Next task" },
        ];
        return Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const computer = yield* BotTaskComputer.BotTaskComputer;
          const config = yield* ServerConfig.ServerConfig;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* allow(computer);
          const turn = harness.commands.find((command) => command.type === "thread.turn.start")!;
          const output = taskOutputDirectory(config.stateDir, turn.threadId);
          yield* Effect.tryPromise(() =>
            NodeFSP.writeFile(NodePath.join(output, "report.txt"), "Preserved bytes"),
          );
          harness.finish(turn.threadId, reportWithBlockers());
          if (typeof failureKind === "number") bot.artifactStatus = failureKind;
          else if (failureKind === "unavailable") bot.artifactStatus = 503;
          else if (failureKind === "malformed") bot.malformedArtifactMetadata = true;
          else bot.failArtifactTransport = true;
          yield* computer.tick;
          if (failureKind === "malformed") {
            // Recover a legacy journal that predates persisted upload deadlines.
            const state = yield* readRecoveryJournal;
            const held = yield* decodeRecoveryHeld(state.held);
            const { outputRetryUntil: _oldDeadline, ...legacy } = held[0] as Record<
              string,
              unknown
            >;
            yield* writeRecoveryJournal({ ...state, held: [legacy] });
          }
          yield* appendRecoveredResult("other", "Other completed result");
          const heartbeats = bot.calls.filter((call) => call.path === "/harness/heartbeat").length;
          const claims = bot.calls.filter((call) => call.path === "/harness/tasks/claim").length;
          yield* TestClock.adjust("2 minutes");
          const restarted = yield* BotTaskComputer.make;
          yield* restarted.tick;
          const status = yield* restarted.getStatus;
          assert.strictEqual(status.state, "idle");
          assert.isNull(status.currentTask);
          assert.include(status.message!, "Finished running “Report”");
          assert.include(status.message!, "saved result and files are awaiting delivery");
          assert.deepEqual(
            bot.results.map((result) => result.taskId),
            ["other"],
          );
          assert.isAbove(
            bot.calls.filter((call) => call.path === "/harness/heartbeat").length,
            heartbeats,
          );
          assert.strictEqual(
            bot.calls.filter((call) => call.path === "/harness/tasks/claim").length,
            claims,
          );
          let raw = yield* secrets.get("tritonai-bot-task-computer");
          let saved = yield* decodeSavedOutputJournal(
            new TextDecoder().decode(Option.getOrThrow(raw)),
          );
          assert.lengthOf(saved.held, 1);
          assert.strictEqual(
            saved.held[0]!.pendingOutputs[0]!.dataBase64,
            Buffer.from("Preserved bytes").toString("base64"),
          );
          const deadline = saved.held[0]!.outputRetryUntil!;
          assert.isAbove(deadline, START);
          yield* TestClock.setTime(START + 12 * 3_600_000);
          const again = yield* BotTaskComputer.make;
          yield* again.tick;
          assert.isNull((yield* again.getStatus).currentTask);
          assert.include(
            (yield* again.getStatus).message!,
            "saved result and files are awaiting delivery",
          );
          raw = yield* secrets.get("tritonai-bot-task-computer");
          saved = yield* decodeSavedOutputJournal(new TextDecoder().decode(Option.getOrThrow(raw)));
          assert.strictEqual(saved.held[0]!.outputRetryUntil, deadline);
          assert.strictEqual(
            saved.held[0]!.pendingOutputs[0]!.dataBase64,
            Buffer.from("Preserved bytes").toString("base64"),
          );
          const uploadCalls = bot.calls.filter((call) => call.path.endsWith("/artifacts")).length;
          bot.resultStatus = 503;
          yield* TestClock.setTime(deadline + 1);
          yield* again.tick;
          assert.strictEqual(
            bot.calls.filter((call) => call.path.endsWith("/artifacts")).length,
            uploadCalls,
          );
          assert.strictEqual(
            bot.calls.filter((call) => call.path === "/harness/tasks/claim").length,
            claims,
          );
          raw = yield* secrets.get("tritonai-bot-task-computer");
          saved = yield* decodeSavedOutputJournal(new TextDecoder().decode(Option.getOrThrow(raw)));
          assert.lengthOf(saved.held[0]!.pendingOutputs, 0);
          assert.lengthOf(saved.held[0]!.outcome.structuredResult!.blockers, 10);
          assert.include(
            saved.held[0]!.outcome.structuredResult!.blockers[0]!,
            "24 hours of retries",
          );
          assert.strictEqual(saved.held[0]!.outcome.status, "completed");
          bot.resultStatus = 200;
          yield* again.tick;
          assert.deepEqual(
            bot.results.map((result) => result.taskId),
            ["other", "deferred"],
          );
          assert.include(String(bot.results[1]!.result), "Finished report");
          assert.strictEqual((yield* again.getStatus).currentTask?.taskId, "next");
          assert.lengthOf(harness.commands, 4);
        }).pipe(Effect.provide(services(bot, harness)));
      },
    );
  }

  it.effect(
    "returns Windows text results and input files with an explicit generated-output blocker",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [
        {
          taskId: "windows-output",
          title: "Windows report",
          prompt: "Review input",
          attachments: [screenshot, document],
        },
      ];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const computer = yield* BotTaskComputer.BotTaskComputer;
        yield* allow(computer);
        const turn = harness.commands.find((command) => command.type === "thread.turn.start")!;
        assert.lengthOf(turn.message.attachments, 2);
        harness.finish(turn.threadId, "Windows text result");
        yield* computer.tick;
        assert.strictEqual(bot.results[0]!.status, "completed");
        assert.include(String(bot.results[0]!.result), "Windows text result");
        const result = bot.results[0]!.structuredResult as {
          artifacts: unknown[];
          blockers: string[];
        };
        assert.lengthOf(result.artifacts, 0);
        assert.include(result.blockers[0]!, "cannot currently be safely exported on Windows");
        assert.lengthOf(
          bot.calls.filter((call) => call.path.endsWith("/artifacts")),
          0,
        );
      }).pipe(
        Effect.provide(services(bot, harness)),
        Effect.provideService(HostProcessPlatform, "win32"),
      );
    },
  );

  for (const rejection of ["expired", "replaced", "expired-after-window"] as const) {
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      `stops pairing after ${rejection} artifact-upload authentication while keeping the saved result for re-pairing`,
      () => {
        const bot = new FakeBot(),
          harness = new FakeHarness();
        bot.tasks = [{ taskId: "upload-auth", title: "Report", prompt: "Return report" }];
        return Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const config = yield* ServerConfig.ServerConfig;
          const computer = yield* BotTaskComputer.BotTaskComputer;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* allow(computer);
          const turn = harness.commands.find((command) => command.type === "thread.turn.start")!;
          const output = taskOutputDirectory(config.stateDir, turn.threadId);
          yield* Effect.tryPromise(() =>
            NodeFSP.writeFile(NodePath.join(output, "report.txt"), "Preserved bytes"),
          );
          harness.finish(turn.threadId, "Finished report");
          if (rejection === "replaced") bot.replaced = true;
          else bot.artifactStatus = 401;
          yield* computer.tick;
          const status = yield* computer.getStatus;
          assert.strictEqual(status.state, rejection === "replaced" ? "replaced" : "off");
          assert.include(
            status.message!,
            rejection === "replaced" ? "Another computer" : "Choose Allow",
          );
          const raw = yield* secrets.get("tritonai-bot-task-computer");
          const saved = yield* decodeSavedOutputJournal(
            new TextDecoder().decode(Option.getOrThrow(raw)),
          );
          assert.strictEqual(saved.held[0]!.outcome.status, "completed");
          assert.strictEqual(
            saved.held[0]!.pendingOutputs[0]!.dataBase64,
            Buffer.from("Preserved bytes").toString("base64"),
          );
          assert.lengthOf(bot.results, 0);
          yield* Effect.tryPromise(() => NodeFSP.rm(output, { recursive: true }));
          harness.threads.delete(turn.threadId);
          bot.replaced = false;
          bot.current = "repaired-token";
          bot.artifactStatus = 200;
          if (rejection === "expired-after-window")
            yield* TestClock.setTime(START + 25 * 3_600_000);
          yield* allow(computer);
          assert.strictEqual(bot.results[0]!.status, "completed");
          assert.include(String(bot.results[0]!.result), "Finished report");
          if (rejection === "expired-after-window") {
            const evidence = bot.results[0]!.structuredResult as {
              artifacts: unknown[];
              blockers: string[];
            };
            assert.lengthOf(evidence.artifacts, 0);
            assert.include(evidence.blockers[0]!, "24 hours of retries");
          }
          assert.lengthOf(harness.commands, 2);
        }).pipe(Effect.provide(services(bot, harness)));
      },
    );
  }

  for (const laterChange of ["follow-up", "deleted"] as const) {
    it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
      `preserves a finished receipt and exact file bytes after a lost upload response and ${laterChange}`,
      () => {
        const bot = new FakeBot(),
          harness = new FakeHarness();
        bot.tasks = [{ taskId: "upload-recovery", title: "Report", prompt: "Return report" }];
        return Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const config = yield* ServerConfig.ServerConfig;
          const computer = yield* BotTaskComputer.BotTaskComputer;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* allow(computer);
          const turn = harness.commands.find((command) => command.type === "thread.turn.start")!;
          const output = taskOutputDirectory(config.stateDir, turn.threadId);
          yield* Effect.tryPromise(() =>
            NodeFSP.writeFile(NodePath.join(output, "report.txt"), "Original bytes"),
          );
          harness.finish(turn.threadId, "Original finished report");
          bot.loseArtifactReply = true;
          yield* computer.tick;
          const raw = yield* secrets.get("tritonai-bot-task-computer");
          const saved = yield* decodeSavedOutputJournal(
            new TextDecoder().decode(Option.getOrThrow(raw)),
          );
          assert.strictEqual(saved.held[0]!.outcome.status, "completed");
          assert.strictEqual(
            saved.held[0]!.pendingOutputs[0]!.dataBase64,
            Buffer.from("Original bytes").toString("base64"),
          );
          yield* Effect.tryPromise(() => NodeFSP.rm(output, { recursive: true }));
          if (laterChange === "deleted") harness.threads.delete(turn.threadId);
          else {
            const thread = harness.threads.get(turn.threadId)!;
            harness.threads.set(turn.threadId, {
              ...thread,
              messages: [
                ...thread.messages,
                { id: "followup", role: "user", text: "New assignment", streaming: false },
              ],
            } as unknown as OrchestrationThread);
          }
          yield* TestClock.setTime(START + 86_400_000);
          const restarted = yield* BotTaskComputer.make;
          yield* restarted.tick;
          const uploads = bot.calls.filter((call) => call.path.endsWith("/artifacts"));
          assert.lengthOf(uploads, 2);
          assert.deepEqual(uploads[0]!.body, uploads[1]!.body);
          assert.strictEqual(bot.artifactWrites.size, 1);
          assert.strictEqual(bot.results[0]!.status, "completed");
          assert.include(String(bot.results[0]!.result), "Original finished report");
          assert.lengthOf(
            (bot.results[0]!.structuredResult as { artifacts: unknown[] }).artifacts,
            1,
          );
          assert.lengthOf(harness.commands, 2);
        }).pipe(Effect.provide(services(bot, harness)));
      },
    );
  }

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "journals each successful artifact receipt before retrying the next upload",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [{ taskId: "partial-upload", title: "Two reports", prompt: "Return reports" }];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const config = yield* ServerConfig.ServerConfig;
        const computer = yield* BotTaskComputer.BotTaskComputer;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* allow(computer);
        const turn = harness.commands.find((command) => command.type === "thread.turn.start")!;
        const output = taskOutputDirectory(config.stateDir, turn.threadId);
        yield* Effect.tryPromise(() => NodeFSP.writeFile(NodePath.join(output, "a.txt"), "A"));
        yield* Effect.tryPromise(() => NodeFSP.writeFile(NodePath.join(output, "b.txt"), "B"));
        harness.finish(turn.threadId, "Two reports completed");
        bot.artifactStatuses = [200, 503];
        yield* computer.tick;
        const raw = yield* secrets.get("tritonai-bot-task-computer");
        const saved = yield* decodeSavedOutputJournal(
          new TextDecoder().decode(Option.getOrThrow(raw)),
        );
        assert.strictEqual(saved.held[0]!.outcome.structuredResult!.artifacts[0]!.label, "a.txt");
        assert.deepEqual(
          saved.held[0]!.pendingOutputs.map((file) => file.name),
          ["b.txt"],
        );
        yield* Effect.tryPromise(() => NodeFSP.rm(output, { recursive: true }));
        harness.threads.delete(turn.threadId);
        const restarted = yield* BotTaskComputer.make;
        yield* restarted.tick;
        assert.deepEqual(
          bot.calls
            .filter((call) => call.path.endsWith("/artifacts"))
            .map((call) => call.body.name),
          ["a.txt", "b.txt", "b.txt"],
        );
        assert.strictEqual(bot.artifactWrites.size, 2);
        assert.strictEqual(bot.results[0]!.status, "completed");
        assert.deepEqual(
          (
            bot.results[0]!.structuredResult as { artifacts: Array<{ label: string }> }
          ).artifacts.map((item) => item.label),
          ["b.txt", "a.txt"],
        );
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "delivers real images and persists downloadable outputs before retrying a result",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [
        {
          taskId: "files-1",
          title: "Review screenshot",
          prompt: "Return a report",
          attachments: [screenshot, document],
        },
      ];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const config = yield* ServerConfig.ServerConfig;
        const computer = yield* BotTaskComputer.BotTaskComputer;
        yield* allow(computer);
        const turn = harness.commands.find((command) => command.type === "thread.turn.start")!;
        const attachment = turn.message.attachments[0]!;
        assert.strictEqual(attachment.type, "image");
        assert.strictEqual(attachment.sizeBytes, screenshotBytes.length);
        const imagePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
        assert.isNotNull(imagePath);
        const bytes = yield* Effect.tryPromise(() => NodeFSP.readFile(imagePath!));
        assert.deepEqual(bytes, screenshotBytes);
        const originalDocument = turn.message.attachments[1]!;
        assert.strictEqual(originalDocument.type, "file");
        const documentPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: originalDocument,
        });
        const fullDocument = yield* Effect.tryPromise(() => NodeFSP.readFile(documentPath!));
        assert.deepEqual(fullDocument, documentBytes);
        const output = taskOutputDirectory(config.stateDir, turn.threadId);
        assert.include(turn.message.text, output);
        yield* Effect.tryPromise(() =>
          NodeFSP.writeFile(NodePath.join(output, "report.txt"), "The screenshot shows a report."),
        );
        harness.finish(
          turn.threadId,
          'Report ready.\n```bot-result\n{"summary":"Report ready","checks":[{"label":"Read screenshot","status":"reported-pass"}]}\n```',
        );
        bot.resultStatus = 503;
        yield* computer.tick;
        const exported = bot.calls.filter((call) => call.path.endsWith("/artifacts"));
        assert.lengthOf(exported, 1);
        assert.strictEqual(exported[0]!.body.claimId, "claim-files-1");
        assert.strictEqual(
          exported[0]!.body.dataBase64,
          Buffer.from("The screenshot shows a report.").toString("base64"),
        );
        // Recreating the worker reads its saved receipt; it does not rerun or reupload files.
        bot.resultStatus = 200;
        const restarted = yield* BotTaskComputer.make;
        yield* restarted.tick;
        assert.lengthOf(
          bot.calls.filter((call) => call.path.endsWith("/artifacts")),
          1,
        );
        assert.lengthOf(harness.commands, 2);
        const result = bot.results[0]!.structuredResult as {
          execution: { threadId: string };
          verification: { status: string };
          artifacts: Array<{ attachmentId: string; provenance: string }>;
          checks: Array<{ provenance: string }>;
        };
        assert.strictEqual(result.execution.threadId, turn.threadId);
        assert.strictEqual(result.verification.status, "unverified");
        assert.strictEqual(result.artifacts[0]!.attachmentId, `att_${"b".repeat(64)}`);
        assert.strictEqual(result.artifacts[0]!.provenance, "harness-upload");
        assert.strictEqual(result.checks[0]!.provenance, "assistant-reported");
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );

  it.effect("refuses damaged attachment bytes before any task turn can run", () => {
    const bot = new FakeBot(),
      harness = new FakeHarness();
    bot.corruptAttachment = true;
    bot.tasks = [
      { taskId: "bad-file", title: "Inspect", prompt: "Inspect it", attachments: [screenshot] },
    ];
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const computer = yield* BotTaskComputer.BotTaskComputer;
      yield* allow(computer);
      yield* computer.tick;
      assert.lengthOf(harness.commands, 0);
      assert.strictEqual(bot.results[0]!.status, "failed");
      assert.include(String(bot.results[0]!.result), "Nothing ran");
    }).pipe(Effect.provide(services(bot, harness)));
  });

  it.effect("runs an approved task as a Harness thread and returns its reply", () => {
    const bot = new FakeBot(),
      harness = new FakeHarness();
    bot.tasks = [
      { taskId: "task-1", title: "Check releases", prompt: "Check the latest releases." },
    ];
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const computer = yield* BotTaskComputer.BotTaskComputer;
      const status = yield* allow(computer);
      const pairing = bot.calls.find((call) => call.path === "/harness/pairing")!;
      assert.strictEqual(pairing.headers.authorization, "Bearer owner-session");
      assert.deepInclude(pairing.body.device as object, { deviceId: status.deviceId });
      assert.strictEqual(status.state, "running");
      assert.strictEqual(status.currentTask?.title, "Check releases");

      const [create, turn] = harness.commands;
      assert.strictEqual(create?.type, "thread.create");
      assert.strictEqual(turn?.type, "thread.turn.start");
      if (create?.type !== "thread.create" || turn?.type !== "thread.turn.start") return;
      assert.strictEqual(create.projectId, PROJECT);
      assert.strictEqual(create.title, "Check releases");
      assert.include(turn.message.text, "Check the latest releases.");

      // Still running: nothing is reported and no other task is claimed.
      yield* TestClock.adjust("30 seconds");
      yield* computer.tick;
      assert.lengthOf(bot.results, 0);
      assert.strictEqual(harness.commands.length, 2);

      harness.finish(create.threadId, "Release 1.4 shipped; two new issues.");
      yield* computer.tick;
      assert.deepInclude(bot.results[0]!, {
        taskId: "task-1",
        claimId: "claim-task-1",
        status: "completed",
      });
      assert.include(String(bot.results[0]!.result), "Release 1.4 shipped");
      assert.include(String(bot.results[0]!.result), "Harness thread: Check releases");
      assert.strictEqual((yield* computer.getStatus).state, "idle");
      // Delivered once only.
      yield* TestClock.adjust("30 seconds");
      yield* computer.tick;
      assert.lengthOf(bot.results, 1);
    }).pipe(Effect.provide(services(bot, harness)));
  });

  it.effect("stops claiming when replaced but still delivers the task it holds", () => {
    const bot = new FakeBot(),
      harness = new FakeHarness();
    bot.tasks = [
      { taskId: "held", title: "Held", prompt: "Do it" },
      { taskId: "next", title: "Next", prompt: "Later" },
    ];
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const computer = yield* BotTaskComputer.BotTaskComputer;
      yield* allow(computer);
      bot.replaced = true;
      yield* TestClock.adjust("2 minutes");
      yield* computer.tick;
      assert.strictEqual((yield* computer.getStatus).state, "replaced");

      const create = harness.commands.find((command) => command.type === "thread.create")!;
      harness.finish(create.threadId, "Held work done.");
      yield* TestClock.adjust("2 minutes");
      yield* computer.tick;
      assert.deepInclude(bot.results[0]!, { taskId: "held", status: "completed" });
      assert.strictEqual(bot.tasks.length, 1, "the next task was never claimed");
      const status = yield* computer.getStatus;
      assert.strictEqual(status.state, "off");
      assert.strictEqual(status.message, "Another computer now runs your TritonAI Bot tasks.");
    }).pipe(Effect.provide(services(bot, harness)));
  });

  it.effect("keeps a saved outcome after a failed delivery and never reruns the task", () => {
    const bot = new FakeBot(),
      harness = new FakeHarness();
    bot.tasks = [{ taskId: "task-1", title: "Report", prompt: "Write it" }];
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const computer = yield* BotTaskComputer.BotTaskComputer;
      yield* allow(computer);
      const create = harness.commands.find((command) => command.type === "thread.create")!;
      harness.finish(create.threadId, "Partial", "error");
      bot.resultStatus = 503;
      yield* computer.tick;
      assert.lengthOf(bot.results, 0);
      const awaitingResult = yield* computer.getStatus;
      assert.strictEqual(awaitingResult.state, "idle");
      assert.isNull(awaitingResult.currentTask);
      assert.include(awaitingResult.message!, "saved result is awaiting delivery");
      bot.resultStatus = 200;
      yield* computer.tick;
      assert.deepInclude(bot.results[0]!, { taskId: "task-1", status: "failed" });
      assert.include(String(bot.results[0]!.result), "Provider failed");
      assert.strictEqual(harness.commands.length, 2);
    }).pipe(Effect.provide(services(bot, harness)));
  });

  for (const rejection of [400, 403, 404, 410, 413, 415, 422] as const) {
    it.effect(
      "retains original evidence and settles result " +
        rejection +
        " with a text-only fallback before claiming new work",
      () => {
        const bot = new FakeBot(),
          harness = new FakeHarness();
        bot.tasks = [
          { taskId: "rejected", title: "Rejected report", prompt: "Write report" },
          { taskId: "next", title: "Next", prompt: "Continue work" },
        ];
        return Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const computer = yield* BotTaskComputer.BotTaskComputer;
          yield* allow(computer);
          const first = harness.commands.find((command) => command.type === "thread.create")!;
          harness.finish(first.threadId, reportWithBlockers());
          bot.resultStatuses = [rejection, 200];
          yield* TestClock.adjust("30 seconds");
          yield* computer.tick;
          const [original, fallback] = bot.calls.filter((call) => call.path === "/harness/results");
          assert.exists(original!.body.structuredResult);
          assert.isUndefined(fallback!.body.structuredResult);
          assert.strictEqual(fallback!.body.status, original!.body.status);
          assert.include(String(fallback!.body.result), String(original!.body.result));
          assert.include(String(fallback!.body.result), "Structured evidence was not delivered");
          assert.include(String(fallback!.body.result), first.threadId);
          const receipt = yield* readResultRecovery("rejected");
          assert.deepEqual(receipt.outcome, {
            status: original!.body.status,
            result: original!.body.result,
            structuredResult: original!.body.structuredResult,
          });
          assert.strictEqual(receipt.rejectedStatus, rejection);
          assert.isFalse(Object.hasOwn(receipt, "token"));
          assert.isFalse(Object.hasOwn(receipt, "pendingOutputs"));
          assert.notInclude(encodeReportedJson(receipt), "dataBase64");
          assert.notInclude(encodeReportedJson(receipt), bot.current);
          assert.strictEqual((yield* computer.getStatus).currentTask?.taskId, "next");
          assert.strictEqual(harness.commands.length, 4);
          const restarted = yield* BotTaskComputer.make;
          yield* restarted.tick;
          assert.deepEqual(yield* readResultRecovery("rejected"), receipt);
          assert.strictEqual(harness.commands.length, 4);
        }).pipe(Effect.provide(services(bot, harness)));
      },
    );
  }

  it.effect(
    "retains a minimal delivery through temporary failure and restart without overwriting the immutable receipt",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [{ taskId: "retry", title: "Report", prompt: "Write report" }];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const computer = yield* BotTaskComputer.BotTaskComputer;
        yield* allow(computer);
        const thread = harness.commands.find((command) => command.type === "thread.create")!;
        harness.finish(thread.threadId, reportWithBlockers());
        bot.resultStatuses = [422, 503];
        yield* computer.tick;
        const receipt = yield* readResultRecovery("retry");
        const saved = yield* readRecoveryJournal;
        const held = yield* decodeRecoveryHeld(saved.held);
        assert.deepInclude(held[0], { deliveryMode: "minimal" });
        const firstFallback = bot.calls.filter((call) => call.path === "/harness/results")[1]!.body;
        const restarted = yield* BotTaskComputer.make;
        yield* restarted.tick;
        assert.deepEqual(bot.results[0], firstFallback);
        assert.deepEqual(yield* readResultRecovery("retry"), receipt);
        assert.strictEqual(harness.commands.length, 2);
        // A lost mode write must reuse the first archive rather than replace its timestamp/evidence.
        yield* writeRecoveryJournal({
          ...saved,
          held: held.map((value) => {
            const {
              deliveryMode: _mode,
              minimalResult: _minimal,
              ...original
            } = value as Record<string, unknown>;
            return original;
          }),
        });
        yield* TestClock.adjust("2 minutes");
        bot.resultStatuses = [400, 409];
        const again = yield* BotTaskComputer.make;
        yield* again.tick;
        assert.deepEqual(yield* readResultRecovery("retry"), receipt);
        assert.lengthOf(yield* decodeRecoveryHeld((yield* readRecoveryJournal).held), 0);
        assert.strictEqual(harness.commands.length, 2);
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );

  it.effect(
    "settles a permanently rejected minimal receipt locally with a persistent scoped warning while future work continues",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [
        { taskId: "unaccepted", title: "Unaccepted report", prompt: "Write report" },
        { taskId: "next", title: "Next", prompt: "Continue work" },
      ];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const computer = yield* BotTaskComputer.BotTaskComputer;
        yield* allow(computer);
        const thread = harness.commands.find((command) => command.type === "thread.create")!;
        harness.finish(thread.threadId, "Complete original report");
        bot.resultStatuses = [400, 422];
        yield* TestClock.adjust("30 seconds");
        yield* computer.tick;
        const receipt = yield* readResultRecovery("unaccepted");
        assert.lengthOf(bot.results, 0);
        let status = yield* computer.getStatus;
        assert.strictEqual(status.currentTask?.taskId, "next");
        assert.include(status.message!, "could not accept the result for “Unaccepted report”");
        assert.notInclude(status.message!, "HTTP");
        const nextThread = harness.commands.filter(
          (command) => command.type === "thread.create",
        )[1]!;
        harness.finish(nextThread.threadId, "Next result");
        yield* computer.tick;
        yield* computer.stop({ ownerToken: null, apiUrl: null });
        const restarted = yield* BotTaskComputer.make;
        assert.notInclude((yield* restarted.getStatus).message ?? "", "Unaccepted report");
        yield* allow(restarted);
        status = yield* restarted.getStatus;
        assert.include(status.message!, "Unaccepted report");
        assert.deepEqual(yield* readResultRecovery("unaccepted"), receipt);
        assert.strictEqual(
          bot.calls.filter(
            (call) => call.path === "/harness/results" && call.body.taskId === "unaccepted",
          ).length,
          2,
        );
        bot.ownerId = "different-owner@ucsd.edu";
        yield* allow(restarted);
        assert.notInclude((yield* restarted.getStatus).message ?? "", "Unaccepted report");
        assert.deepEqual(yield* readResultRecovery("unaccepted"), receipt);
        assert.strictEqual(harness.commands.length, 4);
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );

  it.effect(
    "keeps the original held receipt and sends no fallback when recovery storage fails",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [{ taskId: "retain", title: "Report", prompt: "Write report" }];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const real = yield* ServerSecretStore.ServerSecretStore;
        const computer = yield* BotTaskComputer.make.pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, {
            ...real,
            create: (name, bytes) =>
              name.startsWith("tritonai-bot-result-recovery-")
                ? Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: "synthetic recovery receipt",
                    }),
                  )
                : real.create(name, bytes),
          }),
        );
        yield* allow(computer);
        const thread = harness.commands.find((command) => command.type === "thread.create")!;
        harness.finish(thread.threadId, "Preserve this original result");
        bot.resultStatuses = [400];
        yield* computer.tick;
        assert.strictEqual(bot.calls.filter((call) => call.path === "/harness/results").length, 1);
        const held = yield* decodeRecoveryHeld((yield* readRecoveryJournal).held);
        assert.lengthOf(held, 1);
        assert.isFalse(Object.hasOwn(held[0] as object, "deliveryMode"));
        assert.lengthOf(bot.results, 0);
        assert.strictEqual(harness.commands.length, 2);
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );

  for (const rejection of [403, 404, 410, 415]) {
    it.effect(
      "retains a recovery receipt after both result deliveries return " +
        rejection +
        " and continues new work",
      () => {
        const bot = new FakeBot(),
          harness = new FakeHarness();
        bot.tasks = [
          { taskId: "double-reject", title: "Rejected report", prompt: "Write report" },
          { taskId: "next", title: "Next", prompt: "Continue work" },
        ];
        return Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const computer = yield* BotTaskComputer.BotTaskComputer;
          yield* allow(computer);
          const first = harness.commands.find((command) => command.type === "thread.create")!;
          harness.finish(first.threadId, reportWithBlockers());
          bot.resultStatuses = [rejection, rejection];
          yield* TestClock.adjust("30 seconds");
          yield* computer.tick;
          assert.lengthOf(bot.results, 0);
          const receipt = yield* readResultRecovery("double-reject");
          assert.strictEqual(receipt.rejectedStatus, rejection);
          assert.deepInclude((yield* readRecoveryJournal).deliveryWarning, { status: rejection });
          assert.strictEqual((yield* computer.getStatus).currentTask?.taskId, "next");
          const restarted = yield* BotTaskComputer.make;
          yield* restarted.tick;
          assert.strictEqual((yield* restarted.getStatus).currentTask?.taskId, "next");
          assert.include((yield* restarted.getStatus).message!, "could not accept the result");
          assert.deepEqual(yield* readResultRecovery("double-reject"), receipt);
          assert.strictEqual(
            bot.calls.filter((call) => call.path === "/harness/results").length,
            2,
          );
          assert.strictEqual(harness.commands.length, 4);
        }).pipe(Effect.provide(services(bot, harness)));
      },
    );
  }

  for (const retryStatus of [408, 425, 429]) {
    it.effect(
      "keeps result " + retryStatus + " for retry without archiving or claiming more work",
      () => {
        const bot = new FakeBot(),
          harness = new FakeHarness();
        bot.tasks = [
          { taskId: "retryable", title: "Report", prompt: "Write report" },
          { taskId: "next", title: "Next", prompt: "Continue work" },
        ];
        return Effect.gen(function* () {
          yield* TestClock.setTime(START);
          const computer = yield* BotTaskComputer.BotTaskComputer;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* allow(computer);
          const first = harness.commands.find((command) => command.type === "thread.create")!;
          harness.finish(first.threadId, reportWithBlockers());
          bot.resultStatus = retryStatus;
          yield* TestClock.adjust("30 seconds");
          yield* computer.tick;
          assert.isTrue(Option.isNone(yield* secrets.get(resultRecoveryKey("retryable"))));
          const held = yield* decodeRecoveryHeld((yield* readRecoveryJournal).held);
          assert.lengthOf(held, 1);
          assert.isFalse(Object.hasOwn(held[0] as object, "deliveryMode"));
          assert.strictEqual(bot.tasks.length, 1);
          assert.strictEqual(harness.commands.length, 2);
          const restarted = yield* BotTaskComputer.make;
          yield* restarted.tick;
          assert.isTrue(Option.isNone(yield* secrets.get(resultRecoveryKey("retryable"))));
          assert.strictEqual(bot.tasks.length, 1);
          assert.strictEqual(harness.commands.length, 2);
          const requests = bot.calls.filter((call) => call.path === "/harness/results");
          assert.lengthOf(requests, 2);
          assert.deepEqual(requests[0]!.body, requests[1]!.body);
          bot.resultStatus = 200;
          yield* restarted.tick;
          assert.strictEqual((yield* restarted.getStatus).currentTask?.taskId, "next");
          assert.deepInclude(bot.results[0]!, { taskId: "retryable", status: "completed" });
          assert.strictEqual(harness.commands.length, 4);
        }).pipe(Effect.provide(services(bot, harness)));
      },
    );
  }

  it.effect(
    "shows a current stalled delivery before an earlier rejection warning until new claims can resume",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [
        { taskId: "rejected-old", title: "Earlier report", prompt: "Write report" },
        { taskId: "stalled", title: "Current report", prompt: "Write report" },
        { taskId: "next", title: "Next", prompt: "Continue work" },
      ];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const computer = yield* BotTaskComputer.BotTaskComputer;
        yield* allow(computer);
        const first = harness.commands.find((command) => command.type === "thread.create")!;
        harness.finish(first.threadId, "Earlier report");
        bot.resultStatuses = [400, 422];
        yield* TestClock.adjust("30 seconds");
        yield* computer.tick;
        const second = harness.commands.filter((command) => command.type === "thread.create")[1]!;
        harness.finish(second.threadId, "Current report finished");
        bot.resultStatus = 503;
        yield* computer.tick;
        let status = yield* computer.getStatus;
        assert.include(status.message!, "Finished running “Current report”");
        assert.include(status.message!, "saved result is awaiting delivery");
        assert.include(
          status.message!,
          "New assignments wait until saved result delivery finishes",
        );
        assert.include(status.message!, "could not accept the result for “Earlier report”");
        assert.notInclude(status.message!, "Other assignments can continue");
        assert.isBelow(
          status.message!.indexOf("Current report"),
          status.message!.indexOf("Earlier report"),
        );
        assert.strictEqual(bot.tasks.length, 1);
        assert.strictEqual(harness.commands.length, 4);
        const restarted = yield* BotTaskComputer.make;
        yield* restarted.tick;
        status = yield* restarted.getStatus;
        assert.include(status.message!, "Current report");
        assert.include(status.message!, "Earlier report");
        assert.notInclude(status.message!, "Other assignments can continue");
        assert.strictEqual(bot.tasks.length, 1);
        bot.resultStatus = 200;
        yield* restarted.tick;
        status = yield* restarted.getStatus;
        assert.strictEqual(status.currentTask?.taskId, "next");
        assert.include(status.message!, "Earlier report");
        assert.notInclude(status.message!, "saved result is awaiting delivery");
        assert.strictEqual(harness.commands.length, 6);
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );

  it.effect("reports a task whose turn was rejected as not run", () => {
    const bot = new FakeBot(),
      harness = new FakeHarness();
    harness.rejectTurns = true;
    bot.tasks = [{ taskId: "task-1", title: "Report", prompt: "Write it" }];
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const computer = yield* BotTaskComputer.BotTaskComputer;
      yield* allow(computer).pipe(Effect.ignore);
      yield* TestClock.adjust("6 minutes");
      yield* computer.tick;
      assert.deepInclude(bot.results[0]!, { taskId: "task-1", status: "failed" });
      assert.include(String(bot.results[0]!.result), "nothing ran");
    }).pipe(Effect.provide(services(bot, harness)));
  });

  it.effect(
    "stops locally, tells the bot, and refuses an expired sign-in or unknown project",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const computer = yield* BotTaskComputer.BotTaskComputer;
        const unknown = yield* computer
          .allow({ apiUrl: API, ownerToken: "owner-session", projectId: "missing" })
          .pipe(Effect.flip);
        assert.include(unknown.message, "Choose a project");
        const insecure = yield* computer
          .allow({
            apiUrl: "http://bot.example.ucsd.edu",
            ownerToken: "owner-session",
            projectId: PROJECT,
          })
          .pipe(Effect.flip);
        assert.include(insecure.message, "secure address");
        bot.sessionValid = false;
        const expired = yield* allow(computer).pipe(Effect.flip);
        assert.include(expired.message, "sign-in expired");
        bot.sessionValid = true;

        const status = yield* allow(computer);
        assert.strictEqual(status.state, "idle");
        assert.strictEqual(status.apiUrl, API);
        const stopped = yield* computer.stop({ apiUrl: API, ownerToken: "owner-session" });
        assert.strictEqual(stopped.state, "off");
        assert.deepStrictEqual(bot.calls.at(-1)?.body, { deviceId: status.deviceId });
        const claims = bot.calls.filter((call) => call.path === "/harness/tasks/claim").length;
        yield* TestClock.adjust("5 minutes");
        yield* computer.tick;
        assert.strictEqual(
          bot.calls.filter((call) => call.path === "/harness/tasks/claim").length,
          claims,
        );
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );
  it.effect(
    "refuses an account switch before replacing its cloud pairing while held work remains",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [{ taskId: "held-account-a", title: "Report", prompt: "Write it" }];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const computer = yield* BotTaskComputer.BotTaskComputer;
        yield* allow(computer);
        const pairings = bot.calls.filter((call) => call.path === "/harness/pairing").length;
        bot.ownerId = "other-owner@ucsd.edu";
        const refused = yield* computer
          .allow({ apiUrl: API, ownerToken: "other-owner-session", projectId: PROJECT })
          .pipe(Effect.flip);
        assert.include(refused.message, "another account");
        assert.strictEqual(
          bot.calls.filter((call) => call.path === "/harness/pairing").length,
          pairings,
        );
        const status = yield* computer.getStatus;
        assert.strictEqual(status.userId, "owner@ucsd.edu");
        assert.strictEqual(status.currentTask?.taskId, "held-account-a");
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );

  it.effect("stops locally without sending another service's owner token to the paired bot", () => {
    const bot = new FakeBot(),
      harness = new FakeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const computer = yield* BotTaskComputer.BotTaskComputer;
      yield* allow(computer);
      const callsBefore = bot.calls.length;
      const stopped = yield* computer.stop({
        apiUrl: "https://another.example.test",
        ownerToken: "another-service-session",
      });
      assert.strictEqual(stopped.state, "off");
      assert.strictEqual(bot.calls.length, callsBefore);
    }).pipe(Effect.provide(services(bot, harness)));
  });

  it.effect(
    "recovers a persisted turn after its acknowledgement fails without replaying or claiming nothing ran",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      harness.failAfterTurnPersisted = true;
      bot.tasks = [{ taskId: "task-1", title: "Report", prompt: "Write it" }];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const computer = yield* BotTaskComputer.BotTaskComputer;
        yield* allow(computer);
        yield* computer.tick;
        assert.lengthOf(bot.results, 0);
        const create = harness.commands.find((command) => command.type === "thread.create")!;
        harness.finish(create.threadId, "Completed report");
        yield* computer.tick;
        assert.deepInclude(bot.results[0]!, { status: "completed" });
        assert.include(String(bot.results[0]!.result), "Completed report");
        assert.strictEqual(harness.commands.length, 2);
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );
  it.effect("keeps saved results after a token expires so re-pairing can deliver them", () => {
    const bot = new FakeBot(),
      harness = new FakeHarness();
    bot.tasks = [{ taskId: "task-1", title: "Report", prompt: "Write it" }];
    return Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const computer = yield* BotTaskComputer.BotTaskComputer;
      yield* allow(computer);
      const create = harness.commands.find((command) => command.type === "thread.create")!;
      harness.finish(create.threadId, "Completed report");
      bot.resultStatus = 401;
      yield* computer.tick;
      assert.lengthOf(bot.results, 0);
      assert.strictEqual((yield* computer.getStatus).state, "off");
      assert.include((yield* computer.getStatus).message ?? "", "Choose Allow");
      bot.resultStatus = 200;
      bot.current = "new-worker-token";
      yield* allow(computer);
      assert.deepInclude(bot.results[0]!, { status: "completed" });
      assert.strictEqual(harness.commands.length, 2);
    }).pipe(Effect.provide(services(bot, harness)));
  });

  it.effect(
    "stops a delivery batch on rejected authentication and preserves every held task",
    () => {
      const bot = new FakeBot(),
        harness = new FakeHarness();
      bot.tasks = [
        { taskId: "first", title: "First", prompt: "First task" },
        { taskId: "next", title: "Next", prompt: "Later task" },
      ];
      return Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const computer = yield* BotTaskComputer.BotTaskComputer;
        yield* allow(computer);
        const first = harness.commands.find((command) => command.type === "thread.create")!;
        harness.finish(first.threadId, "First result");
        bot.resultStatus = 503;
        yield* TestClock.adjust("30 seconds");
        yield* computer.tick;
        // Import a terminal receipt retained by an older worker, rather than claiming through an outage.
        yield* appendRecoveredResult("second", "Second result");
        bot.resultStatus = 401;
        const callsBefore = bot.calls.length;
        yield* TestClock.adjust("2 minutes");
        yield* computer.tick;
        assert.deepEqual(
          bot.calls.slice(callsBefore).map((call) => call.path),
          ["/harness/results"],
        );
        assert.strictEqual((yield* computer.getStatus).state, "off");
        assert.strictEqual(bot.tasks.length, 1);
        bot.resultStatus = 200;
        bot.current = "new-worker-token";
        yield* allow(computer);
        assert.deepEqual(
          bot.results.map((result) => result.taskId),
          ["first", "second"],
        );
        assert.include(String(bot.results[0]!.result), "First result");
        assert.include(String(bot.results[1]!.result), "Second result");
        assert.strictEqual(
          harness.commands.filter((command) => command.type === "thread.create").length,
          2,
        );
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );
});
