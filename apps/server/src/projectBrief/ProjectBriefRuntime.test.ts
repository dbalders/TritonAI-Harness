import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorProjectionError, OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Runtime from "./ProjectBriefRuntime.ts";

const projectId = ProjectId.make("project:brief-test");
const threadId = ThreadId.make("thread:brief-test");
const runId = RunId.make("run:brief-test");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const stamp = DateTime.makeUnsafe("2026-10-17T12:00:00Z");
const message = (
  values: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make("message:brief-test"),
  threadId,
  runId,
  nodeId: null,
  role: "user",
  text: "The signed report is due Friday.",
  attachments: [],
  streaming: false,
  createdBy: "user",
  creationSource: "web",
  createdAt: stamp,
  updatedAt: stamp,
  ...values,
});
const run = (values: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run => ({
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  providerThreadId: null,
  userMessageId: message().id,
  rootNodeId: NodeId.make("node:brief-test"),
  activeAttemptId: null,
  status: "running",
  requestedAt: stamp,
  startedAt: stamp,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...values,
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "project-brief-runtime-" });
  const outside = yield* fs.makeTempDirectoryScoped({ prefix: "project-brief-outside-" });
  let selectedProject: Project = {
    id: projectId,
    title: "Operations",
    workspaceRoot: root,
    defaultModelSelection: modelSelection,
    defaultThreadEnvMode: null,
    autoPull: false,
    scripts: [],
    repositoryIdentity: null,
    faviconPath: null,
    projectIcon: null,
    createdAt: DateTime.formatIso(stamp),
    updatedAt: DateTime.formatIso(stamp),
    deletedAt: null,
  };
  let provider: ServerProvider = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: DateTime.formatIso(stamp),
    models: [{ slug: "test-model", name: "Test", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    supportedRuntimeModes: ["approval-required"],
  };
  let shell = {
    id: threadId,
    projectId,
    title: "Operations report",
    runtimeMode: "approval-required",
    worktreePath: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
  let exists = true;
  let messages = [message()];
  let runs = [run()];
  let events: Stream.Stream<OrchestrationV2DomainEvent> = Stream.empty;
  const pendingContinuations = new Set<RunId>();
  let continuationSettled: Effect.Effect<void> = Effect.never;
  let failedShellReads = 0;
  const launches: ThreadLaunch.ThreadLaunchInput[] = [];
  const interrupts: ThreadManagement.ThreadManagementInterruptInput[] = [];
  const records = () =>
    ({ thread: shell, messages, runs }) as unknown as OrchestrationV2ThreadProjection;
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        Effect.succeed(id === projectId ? Option.some(selectedProject) : Option.none()),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.sync(() => [provider]) }),
    Layer.mock(OrchestratorV2)({
      restartContinuationPending: (run) => Effect.sync(() => pendingContinuations.has(run.id)),
      awaitRestartContinuation: () => Effect.suspend(() => continuationSettled),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      getThreadShell: (id) =>
        Effect.suspend(() =>
          failedShellReads-- > 0
            ? Effect.fail(new OrchestratorProjectionError({ threadId: id }))
            : Effect.succeed(exists && id === threadId ? shell : null),
        ),
      getProjectThreadRecords: (input, _fields, filter) => {
        if (input.projectId !== shell.projectId || input.threadId !== threadId || !exists)
          return Effect.fail(
            new ThreadManagement.ThreadManagementThreadNotFoundError({
              projectId: input.projectId,
              threadId: input.threadId,
            }),
          );
        const value = records();
        return Effect.succeed({
          ...value,
          messages: filter?.messageIds
            ? value.messages.filter((item) => filter.messageIds?.includes(item.id))
            : value.messages,
        });
      },
      interruptThread: (input) => {
        interrupts.push(input);
        return Effect.succeed({ type: "no_active_run" as const });
      },
      streamDomainEvents: Stream.suspend(() => events),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        launches.push(input);
        exists = true;
        const initial = input.initialMessage!;
        messages = [message({ id: initial.messageId!, text: initial.text })];
        runs = [run({ userMessageId: initial.messageId! })];
        return Effect.succeed({ threadId, projection: records(), resumed: false });
      },
    }),
  );
  const runtime = yield* Runtime.ProjectBriefRuntime.pipe(
    Effect.provide(Runtime.layer.pipe(Layer.provide(dependencies))),
  );
  return {
    runtime,
    fs,
    path,
    root,
    outside,
    launches,
    interrupts,
    setEvents: (value: readonly OrchestrationV2DomainEvent[]) => {
      events = Stream.fromIterable(value);
    },
    setEventStream: (value: Stream.Stream<OrchestrationV2DomainEvent>) => {
      events = value;
    },
    setContinuationPending: (id: RunId, pending: boolean) => {
      if (pending) pendingContinuations.add(id);
      else pendingContinuations.delete(id);
    },
    setContinuationSettled: (value: Effect.Effect<void>) => {
      continuationSettled = value;
    },
    failNextShellRead: () => {
      failedShellReads = 1;
    },
    setMessages: (value: OrchestrationV2ConversationMessage[]) => {
      messages = value;
    },
    setRuns: (value: OrchestrationV2Run[]) => {
      runs = value;
    },
    setExists: (value: boolean) => {
      exists = value;
    },
    setForeign: () => {
      shell = { ...shell, projectId: ProjectId.make("foreign") };
    },
    setProviderUnavailable: () => {
      provider = { ...provider, enabled: false };
    },
    setNoDefault: () => {
      selectedProject = { ...selectedProject, defaultModelSelection: null };
    },
  };
});

it.layer(NodeServices.layer)("ProjectBriefRuntime", (it) => {
  it.effect("keeps a cut run active until its exact restart continuation returns", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const cutObserved = yield* Deferred.make<void>();
      const childObserved = yield* Deferred.make<void>();
      const doneObserved = yield* Deferred.make<void>();
      const checkpoints = [cutObserved, childObserved, doneObserved];
      const observations: Array<{ runId: RunId; status: string; resultText?: string }> = [];
      const continuationId = RunId.make("run:pending-continuation");
      const cut = run({ status: "cancelled" });
      const unrelated = run({ id: RunId.make("run:unrelated"), ordinal: 3, status: "completed" });
      const child = run({ id: continuationId, ordinal: 2, restartContinuationOfRunId: runId });
      const event = (payload: OrchestrationV2Run, type: "run.updated" | "run.created") => ({
        id: EventId.make(`event:${payload.id}:${payload.status}`),
        threadId,
        occurredAt: stamp,
        type,
        payload,
      });
      f.setEventStream(Stream.fromQueue(events));
      f.setRuns([cut, unrelated]);
      f.setContinuationPending(runId, true);
      expect(yield* f.runtime.reconcile({ projectId, threadId, runId: null })).toEqual({
        runId,
        status: "running",
      });
      yield* f.runtime.changes.pipe(
        Stream.runForEach((changedProject) =>
          Effect.gen(function* () {
            observations.push(
              yield* f.runtime.reconcile({ projectId: changedProject, threadId, runId }),
            );
            const checkpoint = checkpoints[observations.length - 1];
            if (checkpoint) yield* Deferred.succeed(checkpoint, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Queue.offer(events, event(cut, "run.updated"));
      yield* Deferred.await(cutObserved);
      expect(observations[0]).toEqual({ runId, status: "running" });

      f.setRuns([cut, child, unrelated]);
      f.setContinuationPending(runId, false);
      yield* Queue.offer(events, event(child, "run.created"));
      yield* Deferred.await(childObserved);
      expect(observations[1]).toEqual({ runId: continuationId, status: "running" });

      f.setRuns([cut, { ...child, status: "completed" }, unrelated]);
      f.setMessages([
        message({ role: "assistant", runId: continuationId, text: "Continued work returned." }),
        message({ role: "assistant", runId: unrelated.id, text: "Unrelated work." }),
      ]);
      yield* Queue.offer(events, event({ ...child, status: "completed" }, "run.updated"));
      yield* Deferred.await(doneObserved);
      expect(observations[2]).toEqual({
        runId: continuationId,
        status: "completed",
        resultText: "Continued work returned.",
      });
    }),
  );
  it.effect("reconciles a declined continuation when its effect settles without a run event", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const firstObserved = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const cut = run({ status: "cancelled" });
      f.setRuns([cut]);
      f.setContinuationPending(runId, true);
      f.setContinuationSettled(Deferred.await(settled));
      f.setEvents([
        {
          id: EventId.make("event:declined"),
          threadId,
          occurredAt: stamp,
          type: "run.updated",
          payload: cut,
        },
      ]);
      const observations = yield* f.runtime.changes.pipe(
        Stream.mapEffect(() => f.runtime.reconcile({ projectId, threadId, runId })),
        Stream.tap(() => Deferred.succeed(firstObserved, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(firstObserved);
      f.setContinuationPending(runId, false);
      yield* Deferred.succeed(settled, undefined);
      expect(yield* Fiber.join(observations)).toEqual([
        { runId, status: "running" },
        { runId, status: "cancelled" },
      ]);
    }),
  );
  it.effect("keeps observing terminal updates after one unavailable thread lookup", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.failNextShellRead();
      f.setEvents(
        [1, 2].map((index) => ({
          id: EventId.make(`event:${index}`),
          threadId,
          occurredAt: stamp,
          type: "run.updated" as const,
          payload: run({ status: "completed" }),
        })),
      );
      expect(yield* f.runtime.changes.pipe(Stream.runCollect)).toEqual([projectId]);
    }),
  );
  it.effect("freezes exact file text and changes the source identity when its bytes change", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(f.path.join(f.root, "brief.md"), "First signed report.\n");
      const first = yield* f.runtime.capture({
        projectId,
        selection: { kind: "file", relativePath: "brief.md" },
      });
      expect(first.text).toBe("First signed report.\n");
      expect(first.digest).toMatch(/^[a-f0-9]{64}$/u);
      yield* f.fs.writeFileString(f.path.join(f.root, "brief.md"), "Revised signed report.\n");
      const next = yield* f.runtime.capture({
        projectId,
        selection: { kind: "file", relativePath: "brief.md" },
      });
      expect(next.digest).not.toBe(first.digest);
      expect(next.revision).not.toBe(first.revision);
    }),
  );
  it.effect(
    "rejects absolute, parent traversal, and outside-project symlink sources and artifacts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const external = f.path.join(f.outside, "private.md");
        yield* f.fs.writeFileString(external, "not selected");
        yield* f.fs.symlink(external, f.path.join(f.root, "escape.md"));
        for (const relativePath of [
          external,
          "../private.md",
          "escape.md",
          "C:\\outside\\private.md",
        ]) {
          const captured = yield* f.runtime
            .capture({ projectId, selection: { kind: "file", relativePath } })
            .pipe(Effect.flip);
          expect(["invalid_request", "forbidden"]).toContain(captured.code);
          const artifact = yield* f.runtime
            .verifyArtifact({ projectId, threadId, relativePath })
            .pipe(Effect.flip);
          expect(["invalid_request", "forbidden"]).toContain(artifact.code);
        }
      }),
  );
  it.effect("rejects binary, malformed UTF-8, directory and oversized source input", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFile(f.path.join(f.root, "binary"), new Uint8Array([0, 1, 2]));
      yield* f.fs.writeFile(f.path.join(f.root, "bad-utf8"), new Uint8Array([0xff]));
      yield* f.fs.writeFileString(f.path.join(f.root, "large"), "x".repeat(32_001));
      yield* f.fs.makeDirectory(f.path.join(f.root, "directory"));
      for (const relativePath of ["binary", "bad-utf8", "large", "directory"]) {
        expect(
          (yield* f.runtime
            .capture({ projectId, selection: { kind: "file", relativePath } })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_request");
      }
    }),
  );
  it.effect("captures only the selected completed project message", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const selection = { kind: "message" as const, threadId, messageId: message().id };
      f.setMessages([message(), message({ id: MessageId.make("other"), text: "Unselected" })]);
      expect((yield* f.runtime.capture({ projectId, selection })).text).toBe(message().text);
      f.setMessages([message({ streaming: true })]);
      expect((yield* f.runtime.capture({ projectId, selection }).pipe(Effect.flip)).code).toBe(
        "unavailable",
      );
    }),
  );
  it.effect(
    "keeps pasted text with its supplied link and rejects executable or credentialed links",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const selection = {
          kind: "excerpt" as const,
          title: "Pasted Teams request",
          text: "Please prepare the report.",
          url: "https://teams.microsoft.com/l/message/example",
        };
        expect(yield* f.runtime.capture({ projectId, selection })).toMatchObject({
          title: selection.title,
          text: selection.text,
          url: selection.url,
        });
        for (const url of ["javascript:alert(1)", "https://user:password@example.com/"]) {
          expect(
            (yield* f.runtime
              .capture({ projectId, selection: { ...selection, url } })
              .pipe(Effect.flip)).code,
          ).toBe("invalid_request");
        }
      }),
  );
  it.effect(
    "launches supervised work once and recovers its original receipt despite unavailable provider",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setExists(false);
        const input = {
          projectId,
          purpose: "action" as const,
          title: "Prepare report",
          prompt: "Use frozen sources only.",
          commandId: "launch:one",
          threadId,
        };
        const first = yield* f.runtime.launch(input);
        expect(f.launches).toHaveLength(1);
        expect(f.launches[0]).toMatchObject({
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        });
        f.setProviderUnavailable();
        const recovered = yield* f.runtime.launch(input);
        expect(recovered).toEqual(first);
        expect(f.launches).toHaveLength(1);
        expect(
          (yield* f.runtime
            .launch({ ...input, prompt: "Different approved work" })
            .pipe(Effect.flip)).code,
        ).toBe("conflict");
      }),
  );
  it.effect("rejects an unadvertised explicitly chosen model before launching", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setExists(false);
      expect(
        (yield* f.runtime
          .launch({
            projectId,
            purpose: "synthesis",
            title: "Brief",
            prompt: "Prepare",
            commandId: "launch:bad-model",
            threadId,
            modelSelection: { ...modelSelection, model: "invented" },
          })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_request");
      expect(f.launches).toHaveLength(0);
    }),
  );
  it.effect(
    "recovers only the bound initial run and its restart continuation, never a later unrelated result",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const continuationId = RunId.make("run:continuation");
        const unrelatedId = RunId.make("run:unrelated");
        f.setRuns([
          run({ status: "interrupted" }),
          run({
            id: continuationId,
            ordinal: 2,
            restartContinuationOfRunId: runId,
            status: "completed",
          }),
          run({ id: unrelatedId, ordinal: 3, status: "completed" }),
        ]);
        f.setMessages([
          message({
            id: MessageId.make("answer"),
            role: "assistant",
            runId: continuationId,
            text: "Bound result",
          }),
          message({
            id: MessageId.make("later"),
            role: "assistant",
            runId: unrelatedId,
            text: "Unrelated result",
          }),
        ]);
        for (const expectedRun of [runId, null])
          expect(yield* f.runtime.reconcile({ projectId, threadId, runId: expectedRun })).toEqual({
            runId: continuationId,
            status: "completed",
            resultText: "Bound result",
          });
        yield* f.runtime.cancel({ projectId, threadId, runId, commandId: "cancel:one" });
        expect(f.interrupts[0]?.runId).toBe(continuationId);
      }),
  );
  it.effect("requires a project default when the owner has not chosen a model", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setExists(false);
      f.setNoDefault();
      expect(
        (yield* f.runtime
          .launch({
            projectId,
            purpose: "synthesis",
            title: "Brief",
            prompt: "Prepare",
            commandId: "launch:no-model",
            threadId,
          })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_request");
      expect(f.launches).toHaveLength(0);
    }),
  );
  it.effect("refuses messages and artifact reads from another project", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setForeign();
      expect(
        (yield* f.runtime
          .capture({ projectId, selection: { kind: "message", threadId, messageId: message().id } })
          .pipe(Effect.flip)).code,
      ).toBe("unavailable");
      expect(
        (yield* f.runtime
          .verifyArtifact({ projectId, threadId, relativePath: "report.pdf" })
          .pipe(Effect.flip)).code,
      ).toBe("forbidden");
    }),
  );
  it.effect("hashes real binary artifact bytes and notices replacement before acceptance", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFile(
        f.path.join(f.root, "report.pdf"),
        new Uint8Array([37, 80, 68, 70, 0, 1]),
      );
      const first = yield* f.runtime.verifyArtifact({
        projectId,
        threadId,
        relativePath: "report.pdf",
      });
      expect(first.sizeBytes).toBe(6);
      yield* f.fs.writeFile(
        f.path.join(f.root, "report.pdf"),
        new Uint8Array([37, 80, 68, 70, 0, 2]),
      );
      const second = yield* f.runtime.verifyArtifact({
        projectId,
        threadId,
        relativePath: "report.pdf",
      });
      expect(second.digest).not.toBe(first.digest);
    }),
  );
});
