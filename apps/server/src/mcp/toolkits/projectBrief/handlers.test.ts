import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ProjectBriefState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Brief from "../../../projectBrief/ProjectBriefService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { ProjectBriefToolkit } from "./tools.ts";

const projectId = ProjectId.make("project:mcp-test");
const threadId = ThreadId.make("brief-worker");
const runId = RunId.make("run:brief-worker");
const state: ProjectBriefState = {
  projectId,
  revision: 0,
  sourceDigest: "empty",
  sources: [],
  snapshots: [],
  synthesis: null,
  brief: null,
  proposals: [],
  executions: [],
};

const harness = Effect.fn("projectBriefMcpTest.harness")(function* (
  options: { active?: boolean; outside?: boolean } = {},
) {
  const writes: Array<{ threadId: ThreadId; runId: RunId }> = [];
  let reads = 0;
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "session",
    issuedAt: 0,
    capabilities: new Set(["orchestration"]),
    thread: options.outside
      ? undefined
      : {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
    client: options.outside
      ? { sessionId: "outside", label: "outside", access: "full-access" }
      : undefined,
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed(
          liveThreadShell(threadId, {
            activeRunId: options.active === false ? null : runId,
          }),
        ),
    }),
    Layer.mock(Brief.ProjectBriefService)({
      get: () =>
        Effect.sync(() => {
          reads++;
          return state;
        }),
      publishProposal: (_input, caller) =>
        Effect.sync(() => {
          writes.push(caller);
          return state;
        }),
      returnResult: (_input, caller) =>
        Effect.sync(() => {
          writes.push(caller);
          return state;
        }),
    }),
  );
  const toolkit = yield* ProjectBriefToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  return { toolkit, dependencies, writes, reads: () => reads };
});

describe("Project brief MCP authorization", () => {
  it.effect("does not expose a different project's source snapshots", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.toolkit
        .handle("project_brief_read", {
          projectId: ProjectId.make("another-project"),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(h.dependencies));
      expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      expect(h.reads()).toBe(0);
    }),
  );

  it.effect("binds a proposal to the actual calling run", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* h.toolkit
        .handle("project_brief_propose", {
          requestId: "publish-1",
          projectId,
          synthesisId: "synthesis-1",
          sourceDigest: "digest",
          summary: "No accepted commitment is evidenced.",
          proposals: [],
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(h.dependencies));
      expect(result.at(-1)?.result).toMatchObject({ projectId, revision: 0 });
      expect(h.writes).toEqual([{ threadId, runId }]);
    }),
  );

  it.effect("rejects a callback after the worker's run ended", () =>
    Effect.gen(function* () {
      const h = yield* harness({ active: false });
      const result = yield* h.toolkit
        .handle("project_brief_return_result", {
          requestId: "return-1",
          projectId,
          executionId: "work-1",
          summary: "Work returned",
          artifactPaths: ["report.md"],
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(h.dependencies));
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(h.writes).toHaveLength(0);
    }),
  );

  it.effect("does not allow an outside MCP client to impersonate a worker", () =>
    Effect.gen(function* () {
      const h = yield* harness({ outside: true });
      const result = yield* h.toolkit
        .handle("project_brief_return_result", {
          requestId: "return-1",
          projectId,
          executionId: "work-1",
          summary: "Work returned",
          artifactPaths: [],
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(h.dependencies));
      expect(result.at(-1)?.result).toMatchObject({ code: "thread_credential_required" });
      expect(h.writes).toHaveLength(0);
    }),
  );
});
