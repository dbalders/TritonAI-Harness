import { assert, it } from "@effect/vitest";
import { ProjectBriefError, ProjectId, RunId, type ProjectBriefState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Service from "./ProjectBriefService.ts";
import * as Runtime from "./ProjectBriefRuntime.ts";

const projectId = ProjectId.make("brief-project");
const fixture = () => {
  const runs = new Map<string, { runId: RunId; status: "running" | "completed" | "cancelled" }>();
  const control = {
    text: "Prepare the billing guide by Friday.",
    artifactDigest: "artifact-v1",
    launches: 0,
    loseReply: false,
    failBeforeCreate: false,
    failPreflight: false,
    failCancel: false,
    cancelCommandIds: [] as string[],
    prompts: [] as string[],
  };
  const runtime = Layer.succeed(
    Runtime.ProjectBriefRuntime,
    Runtime.ProjectBriefRuntime.of({
      preflight: () =>
        control.failPreflight
          ? Effect.fail(
              new ProjectBriefError({ code: "invalid_request", message: "No default model" }),
            )
          : Effect.void,
      capture: ({ selection }) =>
        Effect.succeed({
          title: selection.kind === "excerpt" ? selection.title : "Selected source",
          text: selection.kind === "excerpt" ? selection.text : control.text,
          revision: control.text,
          digest: control.text,
        }),
      launch: (input) =>
        Effect.gen(function* () {
          control.launches++;
          control.prompts.push(input.prompt);
          if (control.failBeforeCreate)
            return yield* new ProjectBriefError({
              code: "unavailable",
              message: "Connection failed before launch",
            });
          const runId = RunId.make(`run:${input.threadId}`);
          runs.set(input.threadId, { runId, status: "running" });
          if (control.loseReply)
            return yield* new ProjectBriefError({ code: "unavailable", message: "Lost response" });
          return { threadId: input.threadId, runId };
        }),
      reconcile: ({ threadId, runId }) =>
        Effect.gen(function* () {
          const run = runs.get(threadId);
          if (!run || (runId !== null && runId !== run.runId))
            return yield* new ProjectBriefError({
              code: "unavailable",
              message: "Run unavailable",
            });
          return run;
        }),
      verifyArtifact: ({ relativePath }) =>
        Effect.succeed({ relativePath, digest: control.artifactDigest, sizeBytes: 42 }),
      cancel: ({ threadId, commandId }) =>
        Effect.gen(function* () {
          control.cancelCommandIds.push(commandId);
          if (control.failCancel)
            return yield* new ProjectBriefError({
              code: "unavailable",
              message: "Stop interrupted",
            });
          const run = runs.get(threadId);
          if (run) run.status = "cancelled";
        }),
      changes: Stream.empty,
    }),
  );
  return { control, runs, layer: Service.layer.pipe(Layer.provide(runtime)), runtime };
};
const sourceAndBrief = Effect.gen(function* () {
  const service = yield* Service.ProjectBriefService;
  let state = yield* service.execute({
    projectId,
    requestId: "add",
    expectedRevision: 0,
    action: "addSource",
    source: { kind: "file", relativePath: "requirements.md" },
  });
  state = yield* service.execute({
    projectId,
    requestId: "generate",
    expectedRevision: state.revision,
    action: "generate",
  });
  const synthesis = state.synthesis!;
  const caller = { threadId: synthesis.threadId, runId: synthesis.runId! };
  state = yield* service.publishProposal(
    {
      projectId,
      requestId: "publish",
      synthesisId: synthesis.id,
      sourceDigest: synthesis.sourceDigest,
      summary: "A billing guide is requested.",
      proposals: [
        {
          kind: "action",
          title: "Prepare billing guide",
          body: "Write a draft guide.",
          completionCriteria: "A readable Markdown guide exists.",
          citations: [{ snapshotId: state.sources[0]!.snapshotId, quote: "billing guide" }],
        },
      ],
    },
    caller,
  );
  return state;
});
const launch = (state: ProjectBriefState) =>
  Service.ProjectBriefService.pipe(
    Effect.flatMap((service) =>
      service.execute({
        projectId,
        requestId: "launch",
        expectedRevision: state.revision,
        action: "launch",
        proposalId: state.proposals[0]!.id,
        approvedDigest: state.proposals[0]!.approvalDigest,
      }),
    ),
  );

it.effect(
  "persists source snapshots, rejects stale revisions, and makes exact requests idempotent",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      const input = {
        projectId,
        requestId: "source",
        expectedRevision: 0,
        action: "addSource" as const,
        source: { kind: "file" as const, relativePath: "requirements.md" },
      };
      const state = yield* service.execute(input);
      assert.equal((yield* service.execute(input)).revision, state.revision);
      const conflict = yield* service.execute({ ...input, requestId: "other" }).pipe(Effect.flip);
      assert.equal(conflict.code, "conflict");
      const reused = yield* service
        .execute({ ...input, source: { kind: "file", relativePath: "different.md" } })
        .pipe(Effect.flip);
      assert.equal(reused.code, "conflict");
      const reloaded = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(f.layer);
          return yield* Service.ProjectBriefService.pipe(
            Effect.flatMap((fresh) => fresh.get({ projectId })),
            Effect.provide(context),
          );
        }),
      );
      assert.deepEqual(reloaded.sources, state.sources);
      assert.deepEqual(reloaded.snapshots, state.snapshots);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect("rejects forged citations and wrong-run publication without replacing the brief", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Service.ProjectBriefService;
    let state = yield* service.execute({
      projectId,
      requestId: "add",
      expectedRevision: 0,
      action: "addSource",
      source: { kind: "file", relativePath: "requirements.md" },
    });
    state = yield* service.execute({
      projectId,
      requestId: "generate",
      expectedRevision: state.revision,
      action: "generate",
    });
    const synthesis = state.synthesis!;
    const input = {
      projectId,
      requestId: "publish",
      synthesisId: synthesis.id,
      sourceDigest: synthesis.sourceDigest,
      summary: "Summary",
      proposals: [
        {
          kind: "action" as const,
          title: "Guide",
          body: "Write a guide",
          completionCriteria: "File exists",
          citations: [{ snapshotId: state.sources[0]!.snapshotId, quote: "Invented promise" }],
        },
      ],
    };
    assert.equal(
      (yield* service
        .publishProposal(input, { threadId: synthesis.threadId, runId: synthesis.runId! })
        .pipe(Effect.flip)).code,
      "invalid_request",
    );
    assert.equal(
      (yield* service
        .publishProposal(
          { ...input, proposals: [] },
          { threadId: synthesis.threadId, runId: RunId.make("unrelated-run") },
        )
        .pipe(Effect.flip)).code,
      "forbidden",
    );
    assert.equal((yield* service.get({ projectId })).brief, null);
  }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
});

it.effect("recaptures source content before approval and blocks an old proposal", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const state = yield* sourceAndBrief;
    f.control.text = "Do not prepare the billing guide; the request was withdrawn.";
    assert.equal((yield* launch(state).pipe(Effect.flip)).code, "stale_sources");
    const service = yield* Service.ProjectBriefService;
    const current = yield* service.get({ projectId });
    assert.notEqual(current.sourceDigest, state.sourceDigest);
    assert.equal(current.snapshots.length, 2);
    assert.equal(current.executions.length, 0);
    assert.equal(f.control.launches, 1);
  }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
});

it.effect(
  "a reported artifact is not complete until its exact terminal result is owner-reviewed",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      let state = yield* launch(yield* sourceAndBrief);
      const execution = state.executions[0]!;
      state = yield* service.returnResult(
        {
          projectId,
          requestId: "report",
          executionId: execution.id,
          summary: "Created the draft guide.",
          artifactPaths: ["guide.md"],
        },
        { threadId: execution.threadId, runId: execution.runId! },
      );
      assert.equal(state.executions[0]!.status, "running");
      assert.equal(
        (yield* service
          .execute({
            projectId,
            requestId: "early-review",
            expectedRevision: state.revision,
            action: "review",
            executionId: execution.id,
            resultDigest: state.executions[0]!.result!.digest,
          })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      f.runs.get(execution.threadId)!.status = "completed";
      state = yield* service.get({ projectId });
      assert.equal(state.executions[0]!.status, "needs-review");
      const review = {
        projectId,
        requestId: "review",
        expectedRevision: state.revision,
        action: "review" as const,
        executionId: execution.id,
        resultDigest: state.executions[0]!.result!.digest,
      };
      f.control.artifactDigest = "changed-after-report";
      assert.equal((yield* service.execute(review).pipe(Effect.flip)).code, "conflict");
      f.control.artifactDigest = "artifact-v1";
      state = yield* service.execute(review);
      assert.equal(state.executions[0]!.status, "completed");
      state = yield* service.execute({
        projectId,
        requestId: "reopen",
        expectedRevision: state.revision,
        action: "reopenResult",
        executionId: execution.id,
      });
      assert.equal(state.executions[0]!.status, "needs-review");
      state = yield* service.execute({
        projectId,
        requestId: "revise",
        expectedRevision: state.revision,
        action: "revise",
        proposalId: execution.proposalId,
      });
      assert.equal(state.proposals.length, 2);
      assert.equal(state.executions.length, 1);
      assert.equal(state.executions[0]!.result!.artifacts[0]!.digest, "artifact-v1");
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect(
  "lost launch responses recover the existing initial run without dispatching another action",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      const state = yield* sourceAndBrief;
      f.control.loseReply = true;
      const command = {
        projectId,
        requestId: "launch",
        expectedRevision: state.revision,
        action: "launch" as const,
        proposalId: state.proposals[0]!.id,
        approvedDigest: state.proposals[0]!.approvalDigest,
      };
      const uncertain = yield* service.execute(command);
      assert.equal(uncertain.executions[0]!.status, "uncertain");
      assert.equal(uncertain.executions[0]!.runId, null);
      yield* service.execute(command);
      const recovered = yield* service.get({ projectId });
      assert.equal(recovered.executions[0]!.status, "running");
      assert.notEqual(recovered.executions[0]!.runId, null);
      assert.equal(f.control.launches, 2);
      assert.equal(recovered.executions.length, 1);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect(
  "editing changes the approval digest and the old review cannot authorize execution",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      let state = yield* sourceAndBrief;
      const original = state.proposals[0]!;
      state = yield* service.execute({
        projectId,
        requestId: "edit",
        expectedRevision: state.revision,
        action: "edit",
        proposalId: original.id,
        title: "Revised guide",
        body: "Only prepare an outline",
        completionCriteria: "Outline file exists",
      });
      assert.notEqual(state.proposals[0]!.approvalDigest, original.approvalDigest);
      assert.equal(
        (yield* service
          .execute({
            projectId,
            requestId: "launch",
            expectedRevision: state.revision,
            action: "launch",
            proposalId: original.id,
            approvedDigest: original.approvalDigest,
          })
          .pipe(Effect.flip)).code,
        "conflict",
      );
      assert.equal(f.control.launches, 1);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect(
  "source withdrawal preserves executed evidence and cancellation requires actual terminal status",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      let state = yield* launch(yield* sourceAndBrief);
      const execution = state.executions[0]!;
      const snapshotId = state.sources[0]!.snapshotId;
      state = yield* service.execute({
        projectId,
        requestId: "remove",
        expectedRevision: state.revision,
        action: "removeSource",
        sourceId: state.sources[0]!.id,
      });
      assert.ok(state.snapshots.some((snapshot) => snapshot.id === snapshotId));
      state = yield* service.execute({
        projectId,
        requestId: "cancel",
        expectedRevision: state.revision,
        action: "cancel",
        executionId: execution.id,
      });
      assert.equal(state.executions[0]!.stopRequested, true);
      assert.equal(state.executions[0]!.status, "running");
      assert.equal((yield* service.get({ projectId })).executions[0]!.status, "cancelled");
      assert.equal(
        (yield* service
          .returnResult(
            {
              projectId,
              requestId: "late-result",
              executionId: execution.id,
              summary: "Should not arrive",
              artifactPaths: [],
            },
            { threadId: execution.threadId, runId: execution.runId! },
          )
          .pipe(Effect.flip)).code,
        "forbidden",
      );
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect(
  "preflight failures create no pending generation, and prompts name registered tools",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      let state = yield* service.execute({
        projectId,
        requestId: "add",
        expectedRevision: 0,
        action: "addSource",
        source: { kind: "file", relativePath: "requirements.md" },
      });
      const command = {
        projectId,
        requestId: "generate",
        expectedRevision: state.revision,
        action: "generate" as const,
      };
      f.control.failPreflight = true;
      assert.equal((yield* service.execute(command).pipe(Effect.flip)).code, "invalid_request");
      state = yield* service.get({ projectId });
      assert.equal(state.synthesis, null);
      assert.equal(state.revision, command.expectedRevision);
      f.control.failPreflight = false;
      state = yield* service.execute(command);
      assert.ok(f.control.prompts[0]!.includes("project_brief_propose"));
      assert.ok(!f.control.prompts[0]!.includes("project_brief_publish"));
      const synthesis = state.synthesis!;
      state = yield* service.publishProposal(
        {
          projectId,
          requestId: "publish",
          synthesisId: synthesis.id,
          sourceDigest: synthesis.sourceDigest,
          summary: "Prepare a guide.",
          proposals: [
            {
              kind: "action",
              title: "Guide",
              body: "Prepare guide",
              completionCriteria: "Guide exists",
              citations: [{ snapshotId: state.sources[0]!.snapshotId, quote: "billing guide" }],
            },
          ],
        },
        { threadId: synthesis.threadId, runId: synthesis.runId! },
      );
      yield* launch(state);
      assert.ok(f.control.prompts[1]!.includes("project_brief_return_result"));
      assert.ok(!f.control.prompts[1]!.includes("project_brief_report "));
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect("explicit recovery replays the persisted launch without reads allocating work", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Service.ProjectBriefService;
    const proposed = yield* sourceAndBrief;
    f.control.failBeforeCreate = true;
    let state = yield* launch(proposed);
    const execution = state.executions[0]!;
    assert.equal(execution.status, "uncertain");
    const originalPrompt = f.control.prompts[1];
    yield* service.get({ projectId });
    yield* service.get({ projectId });
    assert.equal(f.control.launches, 2);
    f.control.failBeforeCreate = false;
    state = yield* service.execute({
      projectId,
      requestId: "retry",
      expectedRevision: state.revision,
      action: "retry",
      executionId: execution.id,
    });
    assert.equal(state.executions[0]!.threadId, execution.threadId);
    assert.equal(state.executions[0]!.commandId, execution.commandId);
    assert.equal(state.executions[0]!.status, "running");
    assert.equal(f.control.prompts[2], originalPrompt);
    assert.equal(state.executions.length, 1);
  }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
});

it.effect(
  "a terminal run with no report remains unaccepted and permits a preserved revision",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      let state = yield* sourceAndBrief.pipe(Effect.flatMap(launch));
      const execution = state.executions[0]!;
      f.runs.get(execution.threadId)!.status = "completed";
      state = yield* service.get({ projectId });
      assert.equal(state.executions[0]!.status, "result-missing");
      assert.equal(state.executions[0]!.result, null);
      assert.equal(state.executions[0]!.reviewedAt, null);
      state = yield* service.execute({
        projectId,
        requestId: "revision",
        expectedRevision: state.revision,
        action: "revise",
        proposalId: execution.proposalId,
      });
      assert.equal(state.proposals.length, 2);
      assert.equal(state.proposals[1]!.status, "proposed");
      assert.equal(state.executions.length, 1);
      assert.equal(state.executions[0]!.status, "result-missing");
      assert.equal(f.control.launches, 2);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect(
  "retries a durable stop intent after failure and service reload using the original command",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      let state = yield* sourceAndBrief.pipe(Effect.flatMap(launch));
      const execution = state.executions[0]!;
      const command = {
        projectId,
        requestId: "stop",
        expectedRevision: state.revision,
        action: "cancel" as const,
        executionId: execution.id,
      };
      f.control.failCancel = true;
      assert.equal((yield* service.execute(command).pipe(Effect.flip)).code, "unavailable");
      state = yield* service.get({ projectId });
      assert.equal(state.executions[0]!.stopRequested, true);
      assert.equal(state.executions[0]!.status, "running");
      const stopCommandId = state.executions[0]!.stopCommandId;
      assert.ok(stopCommandId);
      // A new UI retry request also reuses the original persisted interruption identity.
      yield* service
        .execute({ ...command, requestId: "stop-again", expectedRevision: state.revision })
        .pipe(Effect.flip);
      f.control.failCancel = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(f.layer);
          yield* Service.ProjectBriefService.pipe(
            Effect.flatMap((fresh) => fresh.execute(command)),
            Effect.provide(context),
          );
        }),
      );
      assert.deepEqual(f.control.cancelCommandIds, [stopCommandId, stopCommandId, stopCommandId]);
      state = yield* service.get({ projectId });
      assert.equal(state.executions[0]!.status, "cancelled");
      assert.equal(state.executions[0]!.reviewedAt, null);
      assert.equal(f.control.launches, 2);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect(
  "discards an ambiguous generation after sources change and fences its late callback",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      let state = yield* service.execute({
        projectId,
        requestId: "source",
        expectedRevision: 0,
        action: "addSource",
        source: { kind: "file", relativePath: "requirements.md" },
      });
      f.control.failBeforeCreate = true;
      state = yield* service.execute({
        projectId,
        requestId: "generate",
        expectedRevision: state.revision,
        action: "generate",
      });
      const synthesis = state.synthesis!;
      assert.equal(synthesis.status, "uncertain");
      f.control.text = "Prepare a revised billing guide by Monday.";
      state = yield* service.execute({
        projectId,
        requestId: "refresh",
        expectedRevision: state.revision,
        action: "refresh",
      });
      assert.equal(
        (yield* service
          .execute({
            projectId,
            requestId: "retry-stale",
            expectedRevision: state.revision,
            action: "retry",
          })
          .pipe(Effect.flip)).code,
        "stale_sources",
      );
      state = yield* service.get({ projectId });
      state = yield* service.execute({
        projectId,
        requestId: "discard",
        expectedRevision: state.revision,
        action: "discardGeneration",
        synthesisId: synthesis.id,
      });
      assert.equal(state.synthesis!.status, "superseded");
      assert.equal(f.control.launches, 1);
      assert.equal(
        (yield* service
          .execute({
            projectId,
            requestId: "retry-retired",
            expectedRevision: state.revision,
            action: "retry",
          })
          .pipe(Effect.flip)).code,
        "invalid_request",
      );
      f.control.failBeforeCreate = false;
      state = yield* service.execute({
        projectId,
        requestId: "generate-new",
        expectedRevision: state.revision,
        action: "generate",
      });
      assert.notEqual(state.synthesis!.threadId, synthesis.threadId);
      assert.equal(state.snapshots.length, 2);
      const oldRunId = RunId.make(`run:${synthesis.threadId}`);
      f.runs.set(synthesis.threadId, { runId: oldRunId, status: "running" });
      assert.equal(
        (yield* service
          .publishProposal(
            {
              projectId,
              requestId: "late-publish",
              synthesisId: synthesis.id,
              sourceDigest: synthesis.sourceDigest,
              summary: "Late result",
              proposals: [],
            },
            { threadId: synthesis.threadId, runId: oldRunId },
          )
          .pipe(Effect.flip)).code,
        "forbidden",
      );
      assert.equal((yield* service.get({ projectId })).brief, null);
      assert.equal(f.control.launches, 2);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect(
  "archives complete evidence durably, fences old callbacks, and starts a fresh bounded brief",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      let state = yield* sourceAndBrief.pipe(Effect.flatMap(launch));
      const execution = state.executions[0]!;
      const synthesis = state.synthesis!;
      const archiveCommand = (requestId: string) => ({
        projectId,
        requestId,
        expectedRevision: state.revision,
        action: "archive" as const,
      });
      assert.equal(
        (yield* service.execute(archiveCommand("archive-active")).pipe(Effect.flip)).code,
        "invalid_request",
      );
      state = yield* service.returnResult(
        {
          projectId,
          requestId: "report",
          executionId: execution.id,
          summary: "Draft ready for owner review",
          artifactPaths: ["guide.md"],
        },
        { threadId: execution.threadId, runId: execution.runId! },
      );
      f.runs.get(execution.threadId)!.status = "completed";
      f.runs.get(synthesis.threadId)!.status = "completed";
      state = yield* service.get({ projectId });
      const original = state;
      const command = archiveCommand("archive");
      state = yield* service.execute(command);
      assert.equal(state.sources.length, 0);
      assert.equal(state.snapshots.length, 0);
      assert.equal(state.proposals.length, 0);
      assert.equal(state.executions.length, 0);
      assert.equal(state.synthesis, null);
      assert.equal(state.brief, null);
      assert.equal(state.archives!.length, 1);
      assert.equal((yield* service.execute(command)).archives!.length, 1);
      const archived = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(f.layer);
          return yield* Service.ProjectBriefService.pipe(
            Effect.flatMap((fresh) =>
              fresh.archiveGet({ projectId, archiveId: state.archives![0]!.id }),
            ),
            Effect.provide(context),
          );
        }),
      );
      assert.deepEqual(archived.state, original);
      assert.equal(archived.state.executions[0]!.status, "needs-review");
      assert.equal(archived.state.executions[0]!.result!.artifacts[0]!.digest, "artifact-v1");
      assert.equal(archived.state.executions[0]!.reviewedAt, null);
      assert.equal(
        (yield* service
          .archiveGet({ projectId: ProjectId.make("other-project"), archiveId: archived.id })
          .pipe(Effect.flip)).code,
        "invalid_request",
      );
      assert.equal(
        (yield* service
          .returnResult(
            {
              projectId,
              requestId: "late-result",
              executionId: execution.id,
              summary: "Late result",
              artifactPaths: [],
            },
            { threadId: execution.threadId, runId: execution.runId! },
          )
          .pipe(Effect.flip)).code,
        "forbidden",
      );
      state = yield* service.execute({
        projectId,
        requestId: "next-source",
        expectedRevision: state.revision,
        action: "addSource",
        source: { kind: "file", relativePath: "requirements.md" },
      });
      assert.equal(state.sources.length, 1);
      assert.equal(state.snapshots.length, 1);
      assert.equal(state.archives!.length, 1);
      assert.equal(f.control.launches, 2);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect("a full proposal history can be archived without deleting historical evidence", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Service.ProjectBriefService;
    let state = yield* service.execute({
      projectId,
      requestId: "source",
      expectedRevision: 0,
      action: "addSource",
      source: { kind: "file", relativePath: "requirements.md" },
    });
    for (let batch = 0; batch < 6; batch++) {
      state = yield* service.execute({
        projectId,
        requestId: `generate-${batch}`,
        expectedRevision: state.revision,
        action: "generate",
      });
      const synthesis = state.synthesis!;
      const publication = service.publishProposal(
        {
          projectId,
          requestId: `publish-${batch}`,
          synthesisId: synthesis.id,
          sourceDigest: synthesis.sourceDigest,
          summary: "Next actions",
          proposals: Array.from({ length: 20 }, (_, index) => ({
            kind: "action" as const,
            title: `Guide ${index}`,
            body: "Prepare the guide",
            completionCriteria: "Guide exists",
            citations: [{ snapshotId: state.sources[0]!.snapshotId, quote: "billing guide" }],
          })),
        },
        { threadId: synthesis.threadId, runId: synthesis.runId! },
      );
      if (batch < 5) state = yield* publication;
      else assert.equal((yield* publication.pipe(Effect.flip)).code, "invalid_request");
      f.runs.get(synthesis.threadId)!.status = "completed";
    }
    assert.equal(state.proposals.length, 100);
    state = yield* service.get({ projectId });
    state = yield* service.execute({
      projectId,
      requestId: "archive-full",
      expectedRevision: state.revision,
      action: "archive",
    });
    const archive = yield* service.archiveGet({ projectId, archiveId: state.archives![0]!.id });
    assert.equal(archive.state.proposals.length, 100);
    assert.equal(archive.state.snapshots[0]!.text, f.control.text);
    assert.equal(state.proposals.length, 0);
    state = yield* service.execute({
      projectId,
      requestId: "source-next",
      expectedRevision: state.revision,
      action: "addSource",
      source: { kind: "file", relativePath: "requirements.md" },
    });
    state = yield* service.execute({
      projectId,
      requestId: "generate-next",
      expectedRevision: state.revision,
      action: "generate",
    });
    assert.equal(state.synthesis!.status, "running");
    assert.equal(state.snapshots.length, 1);
  }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
});

it.effect(
  "withdraws an unconfirmed action after changed sources and fences late work without claiming a stop",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      const proposed = yield* sourceAndBrief;
      f.control.failBeforeCreate = true;
      let state = yield* launch(proposed);
      const execution = state.executions[0]!;
      assert.equal(execution.runId, null);
      f.control.text = "Prepare a revised billing guide by Monday.";
      assert.equal(
        (yield* service
          .execute({
            projectId,
            requestId: "stale-retry",
            expectedRevision: state.revision,
            action: "retry",
            executionId: execution.id,
          })
          .pipe(Effect.flip)).code,
        "stale_sources",
      );
      state = yield* service.get({ projectId });
      const command = {
        projectId,
        requestId: "withdraw",
        expectedRevision: state.revision,
        action: "withdrawExecution" as const,
        executionId: execution.id,
      };
      state = yield* service.execute(command);
      assert.equal(state.executions[0]!.status, "withdrawn");
      assert.equal(state.executions[0]!.stopRequested, false);
      assert.equal(state.executions[0]!.result, null);
      assert.equal(state.executions[0]!.threadId, execution.threadId);
      assert.equal((yield* service.execute(command)).revision, state.revision);
      assert.equal(
        (yield* service
          .execute({
            projectId,
            requestId: "retry-withdrawn",
            expectedRevision: state.revision,
            action: "retry",
            executionId: execution.id,
          })
          .pipe(Effect.flip)).code,
        "invalid_request",
      );
      const lateRunId = RunId.make(`run:${execution.threadId}`);
      f.runs.set(execution.threadId, { runId: lateRunId, status: "running" });
      assert.equal(
        (yield* service
          .returnResult(
            {
              projectId,
              requestId: "late-result",
              executionId: execution.id,
              summary: "Late action result",
              artifactPaths: [],
            },
            { threadId: execution.threadId, runId: lateRunId },
          )
          .pipe(Effect.flip)).code,
        "forbidden",
      );
      state = yield* service.get({ projectId });
      assert.equal(state.executions[0]!.status, "withdrawn");
      f.runs.get(state.synthesis!.threadId)!.status = "completed";
      state = yield* service.execute({
        projectId,
        requestId: "archive-withdrawn",
        expectedRevision: state.revision,
        action: "archive",
      });
      const archive = yield* service.archiveGet({ projectId, archiveId: state.archives![0]!.id });
      assert.equal(archive.state.executions[0]!.status, "withdrawn");
      assert.equal(archive.state.snapshots.length, 2);
      assert.equal(state.executions.length, 0);
      assert.equal(f.control.cancelCommandIds.length, 0);
      assert.equal(f.control.launches, 2);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);

it.effect(
  "recovers an observable uncertain action instead of withdrawing known running work",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* Service.ProjectBriefService;
      const proposed = yield* sourceAndBrief;
      f.control.loseReply = true;
      let state = yield* launch(proposed);
      const execution = state.executions[0]!;
      assert.equal(execution.status, "uncertain");
      assert.equal(
        (yield* service
          .execute({
            projectId,
            requestId: "withdraw",
            expectedRevision: state.revision,
            action: "withdrawExecution",
            executionId: execution.id,
          })
          .pipe(Effect.flip)).code,
        "invalid_request",
      );
      state = yield* service.get({ projectId });
      assert.equal(state.executions[0]!.status, "running");
      assert.ok(state.executions[0]!.runId);
      assert.equal(f.control.cancelCommandIds.length, 0);
    }).pipe(Effect.provide(Layer.provideMerge(f.layer, Sqlite.layerMemory)));
  },
);
