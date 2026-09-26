/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type ProviderApprovalDecision,
  type ProviderEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { assert, describe, vi } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { computeDynamicToolFingerprint, makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];
const MEMORY = "memory-consolidation-thread";
const decodeMcpElicitationResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Number,
      result: Schema.Unknown,
    }),
  ),
);

const decodeMockLaunch = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      noProxy: Schema.String,
      lowerNoProxy: Schema.String,
    }),
  ),
);
const decodeConfigString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildScript() {
  const captured = wireFixture.notifications;
  const extras = [
    {
      method: "item/completed",
      params: {
        threadId: ROOT,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [CHILD_A, CHILD_B],
        },
      },
    },
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    {
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      },
    },
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  return {
    rootThreadId: ROOT,
    notifications: [...captured.filter((entry) => entry.method !== "turn/completed"), ...extras],
  };
}

function capturedStartedActivity(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => {
    const item = (entry.params as { item?: { type?: string; kind?: string } }).item;
    return item?.type === "subAgentActivity" && item.kind === "started";
  });
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      ...captured.params,
      item: {
        ...captured.params.item,
        agentThreadId: childId,
        agentPath: "/root/model-check",
      },
    },
  };
}

function capturedSpawnedThread(childId = CHILD_A) {
  const captured = wireFixture.notifications.find((entry) => entry.method === "thread/started");
  assert.isDefined(captured);
  return {
    ...captured,
    params: {
      thread: {
        ...captured.params.thread,
        id: childId,
        sessionId: childId,
        parentThreadId: ROOT,
        agentNickname: "model-check",
        agentRole: "verifier",
        source: {
          subAgent: {
            thread_spawn: {
              agent_nickname: "model-check",
              agent_path: "/root/model-check",
              agent_role: "verifier",
              depth: 1,
              parent_thread_id: ROOT,
            },
          },
        },
      },
    },
  };
}

function legacySpawn(childId = CHILD_A) {
  return {
    method: "item/completed",
    params: {
      threadId: ROOT,
      turnId: "parent-turn",
      completedAtMs: 1,
      item: {
        type: "collabAgentToolCall",
        id: `spawn-${childId}`,
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: ROOT,
        receiverThreadIds: [childId],
        prompt: "Check the task queue",
        model: "glm-5.3-flash-test",
        reasoningEffort: "medium",
        agentsStates: { [childId]: { status: "pendingInit", message: null } },
      },
    },
  };
}

function childSettings(threadId: string, model: string, effort: string) {
  return {
    method: "thread/settings/updated",
    params: {
      threadId,
      threadSettings: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        collaborationMode: { mode: "default", settings: { model } },
        cwd: "/workspace/repo",
        effort,
        model,
        modelProvider: "openai",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    },
  };
}

function readRecordedRequests() {
  return NodeFS.readFileSync(`${scriptPath}.requests`, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
// Windows cannot run the shebang wrapper; the .cmd sibling does the same job.
const peerPath = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

describe("CodexSessionRuntime collab integration", () => {
  for (const inheritEnvironment of [true, false]) {
    it.effect(
      `routes through the image filter with ${inheritEnvironment ? "inherited" : "explicit"} environment`,
      () =>
        Effect.gen(function* () {
          const gateway = yield* NodeHttpServer.make(NodeHttp.createServer, {
            host: "127.0.0.1",
            port: 0,
          });
          yield* gateway.serve(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              return HttpServerResponse.jsonUnsafe({ url: request.url, body: yield* request.json });
            }),
          );
          const proxyUrl = HttpServer.formatAddress(gateway.address);
          const environment = {
            T3_CODEX_COLLAB_SCRIPT: scriptPath,
            UCSD_AI_BASE_URL: "http://configured.invalid/v1?tenant=test",
            http_proxy: proxyUrl,
            https_proxy: proxyUrl,
            no_proxy: "127.0.0.1,inherited.example",
          };
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              vi.unstubAllEnvs();
              NodeFS.rmSync(scriptPath, { force: true });
              NodeFS.rmSync(`${scriptPath}.launch`, { force: true });
            }),
          );
          for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          NodeFS.writeFileSync(scriptPath, JSON.stringify({ recordLaunch: true }), "utf8");
          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make("thread-image-proxy"),
            binaryPath: peerPath,
            cwd: "/tmp",
            runtimeMode: "full-access",
            ...(inheritEnvironment ? {} : { environment: { ...process.env, ...environment } }),
          });
          yield* runtime.start();
          const launch = yield* decodeMockLaunch(
            NodeFS.readFileSync(`${scriptPath}.launch`, "utf8"),
          );
          assert.include(launch.args, "model_providers.ucsd.supports_websockets=false");
          assert.include(launch.args, "features.enable_request_compression=false");
          assert.equal(launch.noProxy, launch.lowerNoProxy);
          assert.includeMembers(launch.noProxy.split(","), [
            "inherited.example",
            "127.0.0.1",
            "localhost",
          ]);
          const baseUrlConfig = launch.args.find((arg) =>
            arg.startsWith("model_providers.ucsd.base_url="),
          );
          assert.isDefined(baseUrlConfig);
          const baseUrl = yield* decodeConfigString(
            baseUrlConfig!.slice("model_providers.ucsd.base_url=".length),
          );
          assert.equal(new URL(baseUrl).hostname, "127.0.0.1");
          const response = yield* Effect.promise(() =>
            fetch(`${baseUrl}/responses`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              body: JSON.stringify({
                input: [
                  {
                    role: "user",
                    content: ["old", "1", "2", "3", "4"].map((image_url) => ({
                      type: "input_image",
                      image_url,
                    })),
                  },
                ],
              }),
            }),
          );
          assert.equal(response.status, 200);
          const result = yield* Effect.promise(() => response.text());
          assert.include(result, "http://configured.invalid/v1/responses?tenant=test");
          assert.notInclude(result, '"image_url":"old"');
          assert.lengthOf(result.match(/input_image/g) ?? [], 4);
          yield* runtime.close;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("registers legacy spawn results and routes child lifecycle to the Agents surface", () =>
    Effect.gen(function* () {
      const turn = { ...wireFixture.responses.turnStart.turn, id: "legacy-child-turn" };
      const spawn = legacySpawn();
      const script = {
        rootThreadId: ROOT,
        notifications: [
          // Failed spawns and root ids must never create phantom agent rows.
          {
            ...spawn,
            params: {
              ...spawn.params,
              item: { ...spawn.params.item, status: "failed", receiverThreadIds: [] },
            },
          },
          legacySpawn(ROOT),
          spawn,
          spawn,
          { method: "turn/started", params: { threadId: CHILD_A, turn } },
          {
            ...legacySpawn("nested-child"),
            params: {
              ...legacySpawn("nested-child").params,
              threadId: CHILD_A,
              turnId: "child-owned-turn",
              item: { ...legacySpawn("nested-child").params.item, senderThreadId: CHILD_A },
            },
          },
          {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: CHILD_A,
              turnId: turn.id,
              tokenUsage: {
                total: {
                  totalTokens: 30,
                  inputTokens: 20,
                  cachedInputTokens: 0,
                  outputTokens: 10,
                  reasoningOutputTokens: 0,
                },
                last: {
                  totalTokens: 30,
                  inputTokens: 20,
                  cachedInputTokens: 0,
                  outputTokens: 10,
                  reasoningOutputTokens: 0,
                },
                modelContextWindow: 272000,
              },
            },
          },
          {
            method: "item/completed",
            params: {
              threadId: CHILD_A,
              turnId: turn.id,
              completedAtMs: 2,
              item: {
                type: "agentMessage",
                id: "child-answer",
                text: "ALPHA",
                phase: null,
                memoryCitation: null,
              },
            },
          },
          {
            method: "turn/completed",
            params: { threadId: CHILD_A, turn: { ...turn, status: "completed" } },
          },
          {
            ...spawn,
            params: {
              ...spawn.params,
              item: {
                ...spawn.params.item,
                tool: "closeAgent",
                agentsStates: { [CHILD_A]: { status: "completed", message: "ALPHA" } },
              },
            },
          },
          { method: "thread/closed", params: { threadId: CHILD_A } },
          legacySpawn(CHILD_B),
          {
            method: "error",
            params: {
              threadId: CHILD_B,
              turnId: "child-b-turn",
              willRetry: false,
              error: {
                message: "429 Too Many Requests",
                codexErrorInfo: "other",
                additionalDetails: null,
              },
            },
          },
        ],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-legacy-collab"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const collected = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "test legacy agents" });
      const events = Array.from(yield* Fiber.join(collected));
      const starts = events.filter((event) => event.method === "collabAgent/started");
      assert.equal(starts.length, 3);
      // The wire's origin differs from the mock's active parent turn, and a
      // nested spawn has its own child turn. Both belong to the origin turn.
      assert.deepEqual(
        starts.map((event) => event.turnId),
        [TurnId.make("parent-turn"), TurnId.make("parent-turn"), TurnId.make("parent-turn")],
      );
      assert.deepInclude(starts[1]?.payload, {
        agentThreadId: "nested-child",
        parentThreadId: CHILD_A,
      });
      assert.deepInclude(starts[0]?.payload, {
        agentThreadId: CHILD_A,
        model: "glm-5.3-flash-test",
        effort: "medium",
        description: "Check the task queue",
      });
      assert.includeMembers(
        events.map((event) => event.method),
        [
          "collabAgent/turnStarted",
          "collabAgent/tokenUsage",
          "collabAgent/item",
          "collabAgent/turnCompleted",
          "collabAgent/statusChanged",
        ],
      );
      assert.isFalse(
        events.some((event) => event.method === "error"),
        "child errors must not fail the parent",
      );
      assert.equal(events.filter((event) => event.method === "turn/completed").length, 1);
      const closed = events.filter((event) => event.method === "collabAgent/closed");
      assert.equal(closed.length, 1);
      assert.deepInclude(closed[0]?.payload, { agentThreadId: CHILD_A, status: "completed" });
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const registration of ["activity", "legacy"] as const) {
    it.effect(`looks up child identity and model once after ${registration} registration`, () =>
      Effect.gen(function* () {
        const script = {
          rootThreadId: ROOT,
          recordRequests: true,
          notifications: [
            registration === "legacy" ? legacySpawn() : capturedStartedActivity(),
            registration === "legacy" ? legacySpawn() : capturedStartedActivity(),
            {
              ...capturedStartedActivity(CHILD_B),
              params: {
                ...capturedStartedActivity(CHILD_B).params,
                item: { ...capturedStartedActivity(CHILD_B).params.item, kind: "interacted" },
              },
            },
            { method: "thread/closed", params: { threadId: CHILD_B } },
            capturedSpawnedThread(ROOT),
          ],
          childResumeSnapshots: {
            [CHILD_A]: {
              model: "gpt-5.6-luna",
              reasoningEffort: "low",
              nickname: "Lagrange",
              role: "worker",
            },
          },
        };
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(scriptPath, { force: true });
            NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
          }),
        );

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-collab-model-activity"),
          binaryPath: peerPath,
          cwd: "/tmp",
          runtimeMode: "full-access",
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const metadataFiber = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.method === "collabAgent/metadataUpdated" &&
              (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );

        const session = yield* runtime.start();
        assert.equal(session.model, "gpt-5.6-sol");
        yield* runtime.sendTurn({ input: "start one child" });
        const metadataEvents = Array.from(yield* Fiber.join(metadataFiber));
        assert.deepInclude(metadataEvents[0]?.payload, {
          agentThreadId: CHILD_A,
          model: registration === "legacy" ? "glm-5.3-flash-test" : "gpt-5.6-luna",
          effort: registration === "legacy" ? "medium" : "low",
          ...(registration === "legacy" ? { nickname: "Lagrange", role: "worker" } : {}),
        });
        assert.deepEqual(readRecordedRequests(), [
          {
            method: "thread/resume",
            params: { threadId: CHILD_A, excludeTurns: true },
          },
        ]);

        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("keeps child settings and reroutes newer than the resume snapshot", () =>
    Effect.gen(function* () {
      const statusChanged = wireFixture.notifications.find(
        (entry) =>
          entry.method === "thread/status/changed" &&
          (entry.params as { threadId?: string }).threadId === CHILD_A,
      );
      assert.isDefined(statusChanged);
      const script = {
        rootThreadId: ROOT,
        recordRequests: true,
        notifications: [
          childSettings(CHILD_A, "child-before", "medium"),
          capturedSpawnedThread(),
          childSettings(CHILD_A, "child-after", "high"),
          {
            method: "model/rerouted",
            params: {
              threadId: CHILD_A,
              turnId: `${CHILD_A}-turn`,
              fromModel: "child-after",
              toModel: "child-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
          {
            method: "model/rerouted",
            params: {
              threadId: ROOT,
              turnId: `${ROOT}-turn`,
              fromModel: "gpt-5.6-sol",
              toModel: "root-rerouted",
              reason: "highRiskCyberActivity",
            },
          },
        ],
        childResumeSnapshots: {
          [CHILD_A]: {
            model: "stale-snapshot",
            reasoningEffort: "low",
            notifications: [statusChanged],
          },
        },
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-model-spawn"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.method === "collabAgent/statusChanged" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "start one spawned child" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.find((event) => event.method === "collabAgent/started");
      assert.deepInclude(started?.payload, {
        agentThreadId: CHILD_A,
        model: "child-before",
        effort: "medium",
      });
      const childStatus = events.find((event) => event.method === "collabAgent/statusChanged");
      assert.deepInclude(childStatus?.payload, {
        agentThreadId: CHILD_A,
        model: "child-rerouted",
        effort: "high",
      });
      assert.isTrue(
        events.some(
          (event) =>
            event.method === "model/rerouted" &&
            (event.payload as { threadId?: string }).threadId === ROOT,
        ),
        "the root reroute must stay on the parent path",
      );
      assert.isFalse(
        events.some(
          (event) =>
            (event.method === "thread/settings/updated" || event.method === "model/rerouted") &&
            (event.payload as { threadId?: string }).threadId === CHILD_A,
        ),
        "child metadata notifications must not leak to the parent path",
      );
      assert.equal(readRecordedRequests().length, 1);

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not delay the parent turn when the child lookup fails", () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );
      for (const [name, childSnapshot] of [
        ["hang", { hang: true }],
        ["error", { error: "child unavailable" }],
      ] as const) {
        yield* Effect.gen(function* () {
          const marker = `lookup-${name}`;
          const script = {
            rootThreadId: ROOT,
            recordRequests: true,
            resumeRequestMarker: marker,
            notifications: [capturedStartedActivity()],
            childResumeSnapshots: { [CHILD_A]: childSnapshot },
          };
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });

          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make(`thread-collab-model-${name}`),
            binaryPath: peerPath,
            cwd: NodeOS.tmpdir(),
            runtimeMode: "full-access",
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });
          const eventsFiber = yield* runtime.events.pipe(
            Stream.takeUntil(
              (event) =>
                event.method === "serverRequest/resolved" &&
                (event.payload as { requestId?: string }).requestId === marker,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );

          yield* runtime.start();
          yield* runtime.sendTurn({ input: "finish without child metadata" });
          const events = Array.from(yield* Fiber.join(eventsFiber));
          assert.isTrue(events.some((event) => event.method === "turn/completed"));
          assert.equal(readRecordedRequests().length, 1);

          yield* runtime.close;
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }).pipe(Effect.scoped);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("Stop interrupts every live child regardless of registration timing", () =>
    Effect.gen(function* () {
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = legacySpawn(CHILD_B);
      const rootThreadStarted = byIndex.find((entry) => entry.method === "thread/started");
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      assert.isDefined(rootThreadStarted);
      const memoryThreadStarted = {
        ...rootThreadStarted,
        params: {
          thread: {
            ...rootThreadStarted.params.thread,
            id: MEMORY,
            sessionId: MEMORY,
            source: "unknown",
            threadSource: "memory_consolidation",
          },
        },
      };
      const memoryTurnStarted = {
        ...turnStartedA,
        params: {
          ...turnStartedA.params,
          threadId: MEMORY,
          turn: { ...turnStartedA.params.turn, id: "memory-consolidation-turn" },
        },
      };
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [
          turnStartedA,
          registrationA,
          memoryThreadStarted,
          memoryTurnStarted,
          registrationB,
          turnStartedB,
        ],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire and the parent interrupt must still be sent.
      yield* runtime.interruptTurn();

      const parseInterruptLine = (line: string) => JSON.parse(line) as { threadId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(
        interruptedThreads.has(MEMORY),
        "memory consolidation must be interrupted without appearing in chat",
      );
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: peerPath,
        cwd: NodeOS.tmpdir(),
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const elicitationCases = [
    {
      decision: "accept",
      response: { action: "accept", content: { approval: "once" } },
    },
    {
      decision: "acceptForSession",
      response: {
        action: "accept",
        _meta: { persist: "session" },
        content: { approval: "session" },
      },
    },
    {
      decision: "acceptAlways",
      response: {
        action: "accept",
        _meta: { persist: "always" },
        content: { approval: "always" },
      },
    },
    { decision: "decline", response: { action: "decline" } },
    { decision: "cancel", response: { action: "cancel" } },
  ] satisfies ReadonlyArray<{
    readonly decision: ProviderApprovalDecision;
    readonly response: Record<string, unknown>;
  }>;

  for (const { decision, response } of elicitationCases) {
    it.live(`returns the MCP elicitation ${decision} response to Codex`, () =>
      Effect.gen(function* () {
        const scriptedRequest = {
          id: 7001,
          method: "mcpServer/elicitation/request",
          params: {
            mode: "form",
            message: "Allow ChatGPT to use Safari?",
            serverName: "computer-use",
            threadId: ROOT,
            turnId: wireFixture.responses.turnStart.turn.id,
            _meta: { app_name: "Safari", persist: ["session", "always"] },
            requestedSchema: {
              type: "object",
              properties: {
                approval: {
                  type: "string",
                  enum: ["once", "session", "always"],
                },
              },
              required: ["approval"],
            },
          },
        };
        const script = {
          rootThreadId: ROOT,
          holdTurnOpen: true,
          completeTurnOnServerResponse: true,
          notifications: [],
          serverRequests: [scriptedRequest],
        };
        const responsesPath = `${scriptPath}.responses`;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
        NodeFS.rmSync(responsesPath, { force: true });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            NodeFS.rmSync(scriptPath, { force: true });
            NodeFS.rmSync(responsesPath, { force: true });
          }),
        );

        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("thread-codex-mcp-elicitation"),
          binaryPath: peerPath,
          cwd: NodeOS.tmpdir(),
          runtimeMode: "auto",
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const approvalRequested = yield* Deferred.make<ProviderEvent>();
        const turnCompleted = yield* Deferred.make<void>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            event.method === "mcpServer/elicitation/request"
              ? Deferred.succeed(approvalRequested, event).pipe(Effect.asVoid)
              : event.method === "turn/completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        );

        yield* runtime.start();
        yield* runtime.sendTurn({ input: "Open Safari" });
        const approval = yield* Deferred.await(approvalRequested);
        assert.equal(approval.requestKind, "mcp-elicitation");
        assert.isDefined(approval.requestId);
        if (approval.requestId === undefined) return;

        yield* runtime.respondToRequest(approval.requestId, decision);
        yield* Deferred.await(turnCompleted);

        const recordedResponse = yield* decodeMcpElicitationResponse(
          NodeFS.readFileSync(responsesPath, "utf8"),
        );
        assert.equal(recordedResponse.id, scriptedRequest.id);
        assert.deepEqual(recordedResponse.result, response);

        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("keeps the resumed thread's original tool catalog in its resume cursor", () =>
    Effect.gen(function* () {
      const script = { rootThreadId: ROOT, recordRequests: true, notifications: [] };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(`${scriptPath}.requests`, { force: true });
        }),
      );
      const originalTool = {
        name: "fixture_records_search",
        description: "Read fixture records.",
        inputSchema: { type: "object" },
      };
      const grantedLaterTool = {
        name: "fixture_audit_recent",
        description: "Read fixture audit events.",
        inputSchema: { type: "object" },
      };
      const originalCatalog = {
        dynamicToolNames: [originalTool.name],
        dynamicToolFingerprint: computeDynamicToolFingerprint([originalTool]),
      };

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-resume-changed-catalog"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        resumeCursor: { threadId: ROOT, ...originalCatalog },
        dynamicTools: [originalTool, grantedLaterTool],
      });

      const session = yield* runtime.start();
      assert.deepEqual(
        readRecordedRequests().map((request) => request.method),
        ["thread/resume"],
      );
      // Codex restores the thread's original tools, so a later resume must still see a change.
      assert.deepEqual(session.resumeCursor, { threadId: ROOT, ...originalCatalog });
      const turn = yield* runtime.sendTurn({ input: "continue" });
      assert.deepEqual(turn.resumeCursor, { threadId: ROOT, ...originalCatalog });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
