import { OrchestratorMcpFailure, type ProjectBriefError, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectBrief from "../../../projectBrief/ProjectBriefService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, readCaller } from "../../threadAccess.ts";
import { ProjectBriefToolkit } from "./tools.ts";

const failure = (error: ProjectBriefError) =>
  new OrchestratorMcpFailure({
    code: error.code === "forbidden" ? "capability_denied" : "invalid_request",
    message: error.message,
  });

const callerForProject = Effect.fn("projectBriefMcp.callerForProject")(function* (
  projectId: ProjectId,
  writing: boolean,
) {
  const context = yield* readCaller();
  yield* McpInvocationContext.requireThreadScope(context.scope, "Project brief");
  const caller = context.caller;
  if (caller === undefined || caller.projectId !== projectId) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "A project brief is available only to a thread belonging to that project.",
    });
  }
  if (writing) yield* assertLiveCaller(context);
  return caller;
});

export const layer = McpToolAccess.toLayer(ProjectBriefToolkit, {
  project_brief_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* callerForProject(input.projectId, false);
      const service = yield* ProjectBrief.ProjectBriefService;
      return yield* service.get(input).pipe(Effect.mapError(failure));
    }),
  ),
  project_brief_propose: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerForProject(input.projectId, true);
      if (caller.activeRunId === null) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The brief generation run is no longer active.",
        });
      }
      const service = yield* ProjectBrief.ProjectBriefService;
      return yield* service
        .publishProposal(input, {
          threadId: caller.id,
          runId: caller.activeRunId,
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
  project_brief_return_result: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* callerForProject(input.projectId, true);
      if (caller.activeRunId === null) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The assigned work run is no longer active.",
        });
      }
      const service = yield* ProjectBrief.ProjectBriefService;
      return yield* service
        .returnResult(input, {
          threadId: caller.id,
          runId: caller.activeRunId,
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
});
