import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const boundedText = (max: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const ProjectOverviewSource = Schema.Struct({
  ref: boundedText(300),
  title: boundedText(300),
  threadId: Schema.NullOr(ThreadId),
  text: boundedText(4_000),
});
export type ProjectOverviewSource = typeof ProjectOverviewSource.Type;

export const ProjectNextStep = Schema.Struct({
  id: boundedText(100),
  title: boundedText(160),
  reason: boundedText(800),
  prompt: boundedText(4_000),
  sources: Schema.Array(boundedText(300)).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
});
export type ProjectNextStep = typeof ProjectNextStep.Type;

export const ProjectOverview = Schema.Struct({
  description: boundedText(600),
  nextSteps: Schema.Array(ProjectNextStep).check(Schema.isMaxLength(4)),
  sources: Schema.Array(ProjectOverviewSource).check(Schema.isMaxLength(24)),
  sourceDigest: boundedText(100),
  generatedAt: IsoDateTime,
  modelSelection: ModelSelection,
});
export type ProjectOverview = typeof ProjectOverview.Type;

export const ProjectOverviewSnapshot = Schema.Struct({
  projectId: ProjectId,
  overview: Schema.NullOr(ProjectOverview),
  contextAvailable: Schema.Boolean,
  generation: Schema.Struct({
    state: Schema.Literals(["idle", "generating", "error"]),
    message: Schema.NullOr(Schema.String),
  }),
  /** Steps the user dismissed in this project. Absent on servers without next-step feedback. */
  dismissedCount: Schema.optionalKey(Schema.Number),
});
export type ProjectOverviewSnapshot = typeof ProjectOverviewSnapshot.Type;
export const ProjectOverviewGetInput = Schema.Struct({ projectId: ProjectId });
export type ProjectOverviewGetInput = typeof ProjectOverviewGetInput.Type;
export const ProjectOverviewEnsureInput = Schema.Struct({
  projectId: ProjectId,
  force: Schema.optionalKey(Schema.Boolean),
});
export type ProjectOverviewEnsureInput = typeof ProjectOverviewEnsureInput.Type;
/** done: the user already handled it. not-relevant: the user does not want it. */
export const ProjectNextStepFeedbackKind = Schema.Literals(["done", "not-relevant"]);
export type ProjectNextStepFeedbackKind = typeof ProjectNextStepFeedbackKind.Type;
export const ProjectOverviewDismissInput = Schema.Struct({
  projectId: ProjectId,
  stepId: boundedText(100),
  kind: ProjectNextStepFeedbackKind,
});
export type ProjectOverviewDismissInput = typeof ProjectOverviewDismissInput.Type;
/** Restores one dismissed step, or every dismissed step in the project when stepId is absent. */
export const ProjectOverviewRestoreInput = Schema.Struct({
  projectId: ProjectId,
  stepId: Schema.optionalKey(boundedText(100)),
});
export type ProjectOverviewRestoreInput = typeof ProjectOverviewRestoreInput.Type;
export class ProjectOverviewError extends Schema.TaggedError<ProjectOverviewError>()(
  "ProjectOverviewError",
  { message: Schema.String },
) {}
