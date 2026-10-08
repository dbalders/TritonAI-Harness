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
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotTaskComputer from "./BotTaskComputer.ts";

const API = "https://bot.example.ucsd.edu";
const START = Date.parse("2026-10-08T06:00:00.000Z");
const PROJECT = "project-1";

interface Call {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** The bot's control plane: one current token, a queue of tasks, and recorded results. */
class FakeBot {
  readonly calls: Array<Call> = [];
  readonly results: Array<Record<string, unknown>> = [];
  tasks: Array<{ taskId: string; title: string; prompt: string }> = [];
  current = "token-1";
  replaced = false;
  resultStatus = 200;
  sessionValid = true;

  handle(path: string, headers: Record<string, string>, body: Record<string, unknown>) {
    this.calls.push({ path, headers, body });
    const worker = headers["x-triton-harness-token"];
    if (path === "/harness/pairing") {
      return this.sessionValid
        ? { status: 200, json: { ok: true, userId: "owner@ucsd.edu", harnessToken: this.current } }
        : { status: 401, json: { ok: false, error: "Invalid or expired owner session" } };
    }
    if (path === "/harness/pairing/revoke")
      return { status: 200, json: { ok: true, taskComputer: null } };
    if (path === "/harness/results") {
      if (this.resultStatus === 200) this.results.push(body);
      return { status: this.resultStatus, json: {} };
    }
    if (this.replaced || worker !== this.current) {
      return { status: 401, json: { ok: false, replaced: this.replaced } };
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
        Effect.sync(() => {
          const raw =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
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
    Layer.provide(bot.layer()),
    Layer.provide(harness.layer()),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bot-task-test-" })),
  );

const allow = (computer: BotTaskComputer.BotTaskComputer["Service"]) =>
  computer.allow({ apiUrl: API, ownerToken: "owner-session", projectId: PROJECT });

it.layer(NodeServices.layer)("BotTaskComputer", (it) => {
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
      bot.resultStatus = 200;
      yield* computer.tick;
      assert.deepInclude(bot.results[0]!, { taskId: "task-1", status: "failed" });
      assert.include(String(bot.results[0]!.result), "Provider failed");
      assert.strictEqual(harness.commands.length, 2);
    }).pipe(Effect.provide(services(bot, harness)));
  });

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
        { taskId: "second", title: "Second", prompt: "Second task" },
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
        const second = harness.commands.filter((command) => command.type === "thread.create")[1]!;
        harness.finish(second.threadId, "Second result");
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
          3,
        );
      }).pipe(Effect.provide(services(bot, harness)));
    },
  );
});
