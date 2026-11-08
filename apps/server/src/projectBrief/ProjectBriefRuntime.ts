// @effect-diagnostics nodeBuiltinImport:off -- Descriptor reads bound memory and detect changed files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type ProjectBriefArtifact,
  ProjectBriefError,
  type ProjectBriefSourceSelection,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

const SOURCE_MAX_CHARS = 32_000;
const SOURCE_MAX_BYTES = SOURCE_MAX_CHARS * 4;
const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

type ExecutionRef = { projectId: ProjectId; threadId: ThreadId; runId: RunId | null };
export class ProjectBriefRuntime extends Context.Service<
  ProjectBriefRuntime,
  {
    readonly changes: Stream.Stream<ProjectId, ProjectBriefError>;
    /** Validates the requested model, or the project's default, and returns the one to launch with. */
    readonly preflight: (input: {
      projectId: ProjectId;
      modelSelection?: ModelSelection;
    }) => Effect.Effect<ModelSelection, ProjectBriefError>;
    readonly capture: (input: {
      projectId: ProjectId;
      selection: ProjectBriefSourceSelection;
    }) => Effect.Effect<
      { title: string; text: string; revision: string; digest: string; url?: string },
      ProjectBriefError
    >;
    readonly launch: (input: {
      projectId: ProjectId;
      purpose: "synthesis" | "action";
      title: string;
      prompt: string;
      commandId: string;
      threadId: ThreadId;
      modelSelection?: ModelSelection;
    }) => Effect.Effect<{ threadId: ThreadId; runId: RunId }, ProjectBriefError>;
    readonly reconcile: (input: ExecutionRef) => Effect.Effect<
      {
        runId: RunId;
        status: "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
        resultText?: string;
      },
      ProjectBriefError
    >;
    readonly verifyArtifact: (input: {
      projectId: ProjectId;
      threadId: ThreadId;
      relativePath: string;
    }) => Effect.Effect<ProjectBriefArtifact, ProjectBriefError>;
    readonly cancel: (input: {
      projectId: ProjectId;
      threadId: ThreadId;
      runId: RunId;
      commandId: string;
    }) => Effect.Effect<void, ProjectBriefError>;
  }
>()("t3/projectBrief/ProjectBriefRuntime") {}

function inside(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
}

// Recheck after reading: a replaced symlink or edited file cannot become a stable source.
const readProjectFile = Effect.fn("ProjectBriefRuntime.readProjectFile")(function* (
  root: string,
  relativePath: string,
  maxBytes: number,
) {
  if (
    !relativePath.trim() ||
    relativePath.length > 1_000 ||
    relativePath.includes("\0") ||
    NodePath.isAbsolute(relativePath) ||
    NodePath.win32.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).includes("..")
  ) {
    return yield* new ProjectBriefError({
      code: "invalid_request",
      message: "Choose a file inside this project using its relative path.",
    });
  }
  const resolved = yield* Effect.tryPromise({
    try: async () => {
      const realRoot = await NodeFSP.realpath(root);
      const requested = NodePath.resolve(realRoot, relativePath);
      return { realRoot, requested, target: await NodeFSP.realpath(requested) };
    },
    catch: () =>
      new ProjectBriefError({
        code: "unavailable",
        message: "The selected project file is not available.",
      }),
  });
  if (!inside(resolved.realRoot, resolved.target))
    return yield* new ProjectBriefError({
      code: "forbidden",
      message: "The selected file resolves outside this project.",
    });
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        NodeFSP.open(
          resolved.target,
          NodeFS.constants.O_RDONLY |
            (NodeFS.constants.O_NOFOLLOW ?? 0) |
            (NodeFS.constants.O_NONBLOCK ?? 0),
        ),
      catch: () =>
        new ProjectBriefError({
          code: "unavailable",
          message: "The selected project file could not be opened.",
        }),
    }),
    (handle) =>
      Effect.gen(function* () {
        const before = yield* Effect.tryPromise({
          try: () => handle.stat(),
          catch: () =>
            new ProjectBriefError({
              code: "unavailable",
              message: "The selected project file could not be inspected.",
            }),
        });
        if (!before.isFile() || before.size > maxBytes)
          return yield* new ProjectBriefError({
            code: "invalid_request",
            message: "Choose a regular file within this feature's size limit.",
          });
        const contents = yield* Effect.tryPromise({
          try: async () => {
            const bytes = Buffer.alloc(before.size);
            let offset = 0;
            while (offset < bytes.length) {
              const read = await handle.read(bytes, offset, bytes.length - offset, offset);
              if (read.bytesRead === 0) break;
              offset += read.bytesRead;
            }
            const after = await handle.stat();
            const currentTarget = await NodeFSP.realpath(resolved.requested);
            return {
              bytes,
              offset,
              after,
              currentTarget,
              current: await NodeFSP.stat(currentTarget),
            };
          },
          catch: () =>
            new ProjectBriefError({
              code: "unavailable",
              message: "The selected project file could not be read consistently.",
            }),
        });
        if (
          contents.offset !== before.size ||
          contents.after.size !== before.size ||
          contents.after.mtimeMs !== before.mtimeMs ||
          contents.after.ctimeMs !== before.ctimeMs ||
          contents.currentTarget !== resolved.target ||
          !inside(resolved.realRoot, contents.currentTarget) ||
          contents.current.dev !== before.dev ||
          contents.current.ino !== before.ino
        ) {
          return yield* new ProjectBriefError({
            code: "conflict",
            message:
              "The selected project file changed while being read. Refresh it and try again.",
          });
        }
        return {
          bytes: contents.bytes,
          relativePath: NodePath.relative(resolved.realRoot, resolved.requested),
        };
      }),
    (handle) => Effect.promise(() => handle.close()),
  );
});

function currentRun(runs: ReadonlyArray<OrchestrationV2Run>, runId: RunId | null) {
  // A null receipt can recover only the initial run, never a later unrelated conversation turn.
  let run =
    runId === null
      ? runs.find((candidate) => candidate.ordinal === 1)
      : runs.find((candidate) => candidate.id === runId);
  const seen = new Set<RunId>();
  while (run !== undefined) {
    if (seen.has(run.id)) return undefined;
    seen.add(run.id);
    const children = runs.filter((candidate) => candidate.restartContinuationOfRunId === run?.id);
    if (children.length === 0) return run;
    if (children.length !== 1) return undefined;
    run = children[0];
  }
  return undefined;
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const project = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(
        () =>
          new ProjectBriefError({
            code: "unavailable",
            message: "This project could not be loaded.",
          }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ProjectBriefError({
                code: "unavailable",
                message: "This project is no longer available.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const capture: ProjectBriefRuntime["Service"]["capture"] = Effect.fn(
    "ProjectBriefRuntime.capture",
  )(function* (input) {
    const selectedProject = yield* project(input.projectId);
    const selection = input.selection;
    let title: string;
    let text: string;
    let revisionPrefix = "sha256";
    let url: string | undefined;
    if (selection.kind === "file") {
      const file = yield* readProjectFile(
        selectedProject.workspaceRoot,
        selection.relativePath,
        SOURCE_MAX_BYTES,
      );
      title = file.relativePath;
      text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
        catch: () =>
          new ProjectBriefError({
            code: "invalid_request",
            message: "Choose a UTF-8 text file as a source.",
          }),
      });
      if (text.includes("\0"))
        return yield* new ProjectBriefError({
          code: "invalid_request",
          message: "Binary files cannot be used as brief sources.",
        });
    } else if (selection.kind === "message") {
      const records = yield* threads
        .getProjectThreadRecords(
          { projectId: input.projectId, threadId: selection.threadId },
          ["messages"],
          { messageIds: [selection.messageId] },
        )
        .pipe(
          Effect.mapError(
            () =>
              new ProjectBriefError({
                code: "unavailable",
                message: "This message is not available in the selected project.",
              }),
          ),
        );
      const message = records.messages.find(
        (candidate) =>
          candidate.id === selection.messageId && candidate.threadId === selection.threadId,
      );
      if (message === undefined || message.streaming)
        return yield* new ProjectBriefError({
          code: "unavailable",
          message: "Select a completed message from this project.",
        });
      title = `${records.thread.title} · ${message.role}`.slice(0, 300);
      text = message.text;
      revisionPrefix = `message:${digest(`${message.id}:${DateTime.formatIso(message.updatedAt)}`)}`;
    } else {
      title = selection.title;
      text = selection.text;
      if (selection.url !== undefined) {
        const value = selection.url;
        const parsed = yield* Effect.try({
          try: () => new URL(value),
          catch: () =>
            new ProjectBriefError({
              code: "invalid_request",
              message: "Enter an HTTP or HTTPS source link.",
            }),
        });
        if (
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          value.length > 2_000
        )
          return yield* new ProjectBriefError({
            code: "invalid_request",
            message: "Enter an HTTP or HTTPS source link without credentials.",
          });
        url = value;
      }
    }
    if (!text.trim() || text.length > SOURCE_MAX_CHARS || !title.trim() || title.length > 300)
      return yield* new ProjectBriefError({
        code: "invalid_request",
        message: "A source needs a title and between 1 and 32,000 characters of text.",
      });
    const hash = digest(text);
    return {
      title,
      text,
      revision: `${revisionPrefix}:${hash}`,
      digest: hash,
      ...(url === undefined ? {} : { url }),
    };
  });

  const resolveModel = Effect.fn("ProjectBriefRuntime.resolveModel")(function* (input: {
    projectId: ProjectId;
    modelSelection?: ModelSelection;
  }) {
    const selectedProject = yield* project(input.projectId);
    const modelSelection = input.modelSelection ?? selectedProject.defaultModelSelection;
    if (modelSelection === null)
      return yield* new ProjectBriefError({
        code: "invalid_request",
        message: "Choose a model or set this project's default model first.",
      });
    const enabled = yield* threads.isProviderInstanceEnabledForProject({
      projectId: input.projectId,
      instanceId: modelSelection.instanceId,
    });
    if (!enabled)
      return yield* new ProjectBriefError({
        code: "invalid_request",
        message: "The selected provider is turned off for this project.",
      });
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === modelSelection.instanceId,
    );
    if (
      provider === undefined ||
      !provider.enabled ||
      !provider.installed ||
      !isProviderAvailable(provider) ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.auth.status === "unauthenticated"
    )
      return yield* new ProjectBriefError({
        code: "unavailable",
        message: "The selected provider is not ready. Check its connection and availability.",
      });
    const model = provider.models.find((candidate) => candidate.slug === modelSelection.model);
    if (
      model === undefined ||
      (provider.supportedRuntimeModes !== undefined &&
        !provider.supportedRuntimeModes.includes("approval-required"))
    )
      return yield* new ProjectBriefError({
        code: "invalid_request",
        message: "Choose an available model that supports supervised execution.",
      });
    const seenOptions = new Set<string>();
    for (const option of modelSelection.options ?? []) {
      const descriptors = model.capabilities?.optionDescriptors;
      const descriptor = descriptors?.find((candidate) => candidate.id === option.id);
      if (
        seenOptions.has(option.id) ||
        (descriptors !== undefined &&
          (descriptor === undefined ||
            (descriptor.type === "boolean" && typeof option.value !== "boolean") ||
            (descriptor.type === "select" &&
              !descriptor.options.some((candidate) => candidate.id === option.value))))
      )
        return yield* new ProjectBriefError({
          code: "invalid_request",
          message: "The selected model options are not valid for this model.",
        });
      seenOptions.add(option.id);
    }
    return modelSelection;
  });
  const preflight: ProjectBriefRuntime["Service"]["preflight"] = resolveModel;

  const launch: ProjectBriefRuntime["Service"]["launch"] = Effect.fn("ProjectBriefRuntime.launch")(
    function* (input) {
      yield* project(input.projectId);
      const messageId = MessageId.make(`project-brief-${digest(input.commandId).slice(0, 48)}`);
      const existing = yield* threads.getThreadShell(input.threadId).pipe(
        Effect.mapError(
          () =>
            new ProjectBriefError({
              code: "unavailable",
              message: "The execution receipt could not be checked.",
            }),
        ),
      );
      // Replay accepted launches even if defaults or provider availability have since changed.
      if (existing !== null) {
        const records = yield* threads
          .getProjectThreadRecords(input, ["messages", "runs"], { messageIds: [messageId] })
          .pipe(
            Effect.mapError(
              () =>
                new ProjectBriefError({
                  code: "conflict",
                  message: "The execution thread does not belong to this project.",
                }),
            ),
          );
        const message = records.messages.find((candidate) => candidate.id === messageId);
        const run = records.runs.find((candidate) => candidate.userMessageId === messageId);
        if (message?.text !== input.prompt || records.thread.runtimeMode !== "approval-required")
          return yield* new ProjectBriefError({
            code: "conflict",
            message: "This launch identifier belongs to a different request.",
          });
        if (run !== undefined) return { threadId: input.threadId, runId: run.id };
        return yield* new ProjectBriefError({
          code: "unavailable",
          message:
            "The launch was recorded but its run is not yet confirmed. Refresh before retrying.",
        });
      }
      const modelSelection = yield* resolveModel(input);
      // No pending uploads are involved; the existing launch service owns the durable provider run.
      const launched = yield* launches
        .launch({
          commandId: CommandId.make(input.commandId),
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "server",
          initialMessage: { messageId, text: input.prompt, attachments: [] },
        })
        .pipe(
          Effect.mapError(
            () =>
              new ProjectBriefError({
                code: "unavailable",
                message: "Execution could not be confirmed. Refresh its thread before retrying.",
              }),
          ),
        );
      const run = launched.projection.runs.find(
        (candidate) => candidate.userMessageId === messageId,
      );
      if (run === undefined)
        return yield* new ProjectBriefError({
          code: "unavailable",
          message: "The execution thread exists but its run is not confirmed.",
        });
      return { threadId: launched.threadId, runId: run.id };
    },
  );

  const boundRun = Effect.fn("ProjectBriefRuntime.boundRun")(function* (input: ExecutionRef) {
    yield* project(input.projectId);
    const records = yield* threads.getProjectThreadRecords(input, ["runs", "messages"]).pipe(
      Effect.mapError(
        () =>
          new ProjectBriefError({
            code: "unavailable",
            message: "The execution thread is no longer available in this project.",
          }),
      ),
    );
    const run = currentRun(records.runs, input.runId);
    if (run === undefined)
      return yield* new ProjectBriefError({
        code: "unavailable",
        message: "The exact execution run could not be confirmed.",
      });
    return { records, run };
  });
  const reconcile: ProjectBriefRuntime["Service"]["reconcile"] = Effect.fn(
    "ProjectBriefRuntime.reconcile",
  )(function* (input) {
    let { records, run } = yield* boundRun(input);
    let continuationPending =
      ThreadManagement.isTerminalRunStatus(run.status) &&
      (yield* orchestrator.restartContinuationPending(run));
    if (ThreadManagement.isTerminalRunStatus(run.status) && !continuationPending) {
      // The continuation may have committed after the first projection read but
      // before its effect settled. Re-read before accepting the cut run as final.
      ({ records, run } = yield* boundRun(input));
      continuationPending =
        ThreadManagement.isTerminalRunStatus(run.status) &&
        (yield* orchestrator.restartContinuationPending(run));
    }
    const status =
      continuationPending ||
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "waiting"
        ? "running"
        : run.status === "rolled_back"
          ? "interrupted"
          : run.status;
    const result = records.messages.findLast(
      (message) => message.runId === run.id && message.role === "assistant" && !message.streaming,
    );
    return {
      runId: run.id,
      status,
      ...(!continuationPending && result?.text
        ? { resultText: result.text.slice(0, SOURCE_MAX_CHARS) }
        : {}),
    };
  });
  const verifyArtifact: ProjectBriefRuntime["Service"]["verifyArtifact"] = Effect.fn(
    "ProjectBriefRuntime.verifyArtifact",
  )(function* (input) {
    const selectedProject = yield* project(input.projectId);
    const records = yield* threads.getProjectThreadRecords(input, []).pipe(
      Effect.mapError(
        () =>
          new ProjectBriefError({
            code: "forbidden",
            message: "The result thread does not belong to this project.",
          }),
      ),
    );
    if (
      records.thread.worktreePath !== null &&
      NodePath.resolve(records.thread.worktreePath) !==
        NodePath.resolve(selectedProject.workspaceRoot)
    )
      return yield* new ProjectBriefError({
        code: "forbidden",
        message:
          "This result was produced in a different workspace. Review it in its execution thread.",
      });
    const file = yield* readProjectFile(
      selectedProject.workspaceRoot,
      input.relativePath,
      ARTIFACT_MAX_BYTES,
    );
    return {
      relativePath: file.relativePath,
      digest: digest(file.bytes),
      sizeBytes: file.bytes.length,
    };
  });
  const cancel: ProjectBriefRuntime["Service"]["cancel"] = Effect.fn("ProjectBriefRuntime.cancel")(
    function* (input) {
      const { run } = yield* boundRun(input);
      yield* threads
        .interruptThread({
          ...input,
          runId: run.id,
          commandId: CommandId.make(input.commandId),
          reason: "The project owner cancelled this action.",
        })
        .pipe(
          Effect.mapError(
            () =>
              new ProjectBriefError({
                code: "unavailable",
                message:
                  "The stop request could not be confirmed. Open the execution thread to check it.",
              }),
          ),
        );
    },
  );
  const changes = threads.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        (event.type === "run.updated" &&
          ThreadManagement.isTerminalRunStatus(event.payload.status)) ||
        (event.type === "run.created" && event.payload.restartContinuationOfRunId !== undefined),
    ),
    Stream.flatMap(
      (event) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const shell = yield* threads.getThreadShell(event.threadId).pipe(
              // An unreadable/deleted thread must not disable other projects' updates.
              Effect.catch(() =>
                Effect.logWarning("Skipped an unavailable project brief execution update.").pipe(
                  Effect.as(null),
                ),
              ),
            );
            if (shell === null) return Stream.empty;
            const update = Stream.succeed(shell.projectId);
            if (
              event.type !== "run.updated" ||
              !(yield* orchestrator.restartContinuationPending(event.payload))
            )
              return update;
            // A declined continuation emits no run event. Its settled effect must
            // wake reconciliation too, without blocking other runs' updates.
            return Stream.concat(
              update,
              Stream.fromEffect(
                orchestrator
                  .awaitRestartContinuation(event.payload)
                  .pipe(Effect.as(shell.projectId)),
              ),
            );
          }),
        ),
      { concurrency: "unbounded" },
    ),
    Stream.mapError(
      () =>
        new ProjectBriefError({
          code: "unavailable",
          message:
            "Execution updates could not be observed. Refresh the project to check its current state.",
        }),
    ),
  );
  return ProjectBriefRuntime.of({
    capture,
    launch,
    reconcile,
    verifyArtifact,
    cancel,
    changes,
    preflight,
  });
});

export const layer = Layer.effect(ProjectBriefRuntime, make);
