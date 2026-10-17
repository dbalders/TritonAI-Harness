import * as Schema from "effect/Schema";
import { IsoDateTime, MessageId, ProjectId, RunId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ProjectBriefSourceSelection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file"), relativePath: Title }),
  Schema.Struct({ kind: Schema.Literal("message"), threadId: ThreadId, messageId: MessageId }),
  Schema.Struct({
    kind: Schema.Literal("excerpt"),
    title: Title,
    text: Text,
    url: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  }),
]);
export type ProjectBriefSourceSelection = typeof ProjectBriefSourceSelection.Type;
export const ProjectBriefSnapshot = Schema.Struct({
  id: Id,
  sourceId: Id,
  title: Title,
  text: Text,
  revision: Id,
  digest: Id,
  capturedAt: IsoDateTime,
  url: Schema.optional(Schema.String),
});
export type ProjectBriefSnapshot = typeof ProjectBriefSnapshot.Type;
export const ProjectBriefSource = Schema.Struct({
  id: Id,
  selection: ProjectBriefSourceSelection,
  snapshotId: Id,
  status: Schema.Literals(["available", "unavailable"]),
});
export type ProjectBriefSource = typeof ProjectBriefSource.Type;
export const ProjectBriefCitation = Schema.Struct({
  snapshotId: Id,
  quote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
});
export type ProjectBriefCitation = typeof ProjectBriefCitation.Type;
export const ProjectBriefProposalDraft = Schema.Struct({
  kind: Schema.Literals(["decision", "action"]),
  title: Title,
  body: Text,
  completionCriteria: Text,
  citations: Schema.Array(ProjectBriefCitation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
});
export type ProjectBriefProposalDraft = typeof ProjectBriefProposalDraft.Type;
export const ProjectBriefProposal = Schema.Struct({
  ...ProjectBriefProposalDraft.fields,
  id: Id,
  synthesisId: Id,
  sourceDigest: Id,
  approvalDigest: Id,
  status: Schema.Literals(["proposed", "accepted", "dismissed", "superseded"]),
});
export type ProjectBriefProposal = typeof ProjectBriefProposal.Type;
export const ProjectBriefArtifact = Schema.Struct({
  relativePath: Schema.String,
  digest: Id,
  sizeBytes: Revision,
});
export type ProjectBriefArtifact = typeof ProjectBriefArtifact.Type;
export const ProjectBriefExecution = Schema.Struct({
  id: Id,
  proposalId: Id,
  sourceDigest: Id,
  approvedDigest: Id,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  commandId: Id,
  status: Schema.Literals([
    "dispatch-pending",
    "queued",
    "running",
    "needs-review",
    "completed",
    "failed",
    "interrupted",
    "uncertain",
    "result-missing",
    "withdrawn",
    "cancelled",
  ]),
  result: Schema.NullOr(
    Schema.Struct({
      summary: Text,
      artifacts: Schema.Array(ProjectBriefArtifact).check(Schema.isMaxLength(20)),
      digest: Id,
      reportedAt: IsoDateTime,
      runId: RunId,
    }),
  ),
  reviewedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  stopRequested: Schema.Boolean,
  stopCommandId: Schema.optional(Id),
});
export type ProjectBriefExecution = typeof ProjectBriefExecution.Type;
export const ProjectBriefSynthesis = Schema.Struct({
  id: Id,
  sourceDigest: Id,
  snapshotIds: Schema.Array(Id),
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  commandId: Id,
  status: Schema.Literals([
    "dispatch-pending",
    "running",
    "published",
    "failed",
    "uncertain",
    "superseded",
  ]),
});
export type ProjectBriefSynthesis = typeof ProjectBriefSynthesis.Type;
export const ProjectBriefArchiveSummary = Schema.Struct({
  id: Id,
  archivedAt: IsoDateTime,
  sourceCount: Revision,
  proposalCount: Revision,
  executionCount: Revision,
});
export type ProjectBriefArchiveSummary = typeof ProjectBriefArchiveSummary.Type;
export const ProjectBriefState = Schema.Struct({
  projectId: ProjectId,
  revision: Revision,
  sourceDigest: Id,
  sources: Schema.Array(ProjectBriefSource),
  snapshots: Schema.Array(ProjectBriefSnapshot),
  synthesis: Schema.NullOr(ProjectBriefSynthesis),
  brief: Schema.NullOr(
    Schema.Struct({
      summary: Text,
      generatedAt: IsoDateTime,
      sourceDigest: Id,
      threadId: ThreadId,
      runId: RunId,
    }),
  ),
  proposals: Schema.Array(ProjectBriefProposal),
  executions: Schema.Array(ProjectBriefExecution),
  archives: Schema.optional(Schema.Array(ProjectBriefArchiveSummary).check(Schema.isMaxLength(20))),
});
export type ProjectBriefState = typeof ProjectBriefState.Type;
export const ProjectBriefArchiveGetInput = Schema.Struct({ projectId: ProjectId, archiveId: Id });
export type ProjectBriefArchiveGetInput = typeof ProjectBriefArchiveGetInput.Type;
export const ProjectBriefArchive = Schema.Struct({
  id: Id,
  archivedAt: IsoDateTime,
  state: ProjectBriefState,
});
export type ProjectBriefArchive = typeof ProjectBriefArchive.Type;
export const ProjectBriefGetInput = Schema.Struct({ projectId: ProjectId });
export type ProjectBriefGetInput = typeof ProjectBriefGetInput.Type;
const CommandFields = { requestId: Id, projectId: ProjectId, expectedRevision: Revision };
export const ProjectBriefCommand = Schema.Union([
  Schema.Struct({
    ...CommandFields,
    action: Schema.Literal("addSource"),
    source: ProjectBriefSourceSelection,
  }),
  Schema.Struct({ ...CommandFields, action: Schema.Literal("removeSource"), sourceId: Id }),
  Schema.Struct({ ...CommandFields, action: Schema.Literal("refresh") }),
  Schema.Struct({ ...CommandFields, action: Schema.Literal("archive") }),
  Schema.Struct({ ...CommandFields, action: Schema.Literal("discardGeneration"), synthesisId: Id }),
  Schema.Struct({
    ...CommandFields,
    action: Schema.Literal("generate"),
    modelSelection: Schema.optional(ModelSelection),
  }),
  Schema.Struct({
    ...CommandFields,
    action: Schema.Literal("decide"),
    proposalId: Id,
    decision: Schema.Literals(["accept", "dismiss", "reopen"]),
  }),
  Schema.Struct({
    ...CommandFields,
    action: Schema.Literal("edit"),
    proposalId: Id,
    title: Title,
    body: Text,
    completionCriteria: Text,
  }),
  Schema.Struct({
    ...CommandFields,
    action: Schema.Literal("launch"),
    proposalId: Id,
    approvedDigest: Id,
    modelSelection: Schema.optional(ModelSelection),
  }),
  Schema.Struct({
    ...CommandFields,
    action: Schema.Literal("review"),
    executionId: Id,
    resultDigest: Id,
  }),
  Schema.Struct({ ...CommandFields, action: Schema.Literal("reopenResult"), executionId: Id }),
  Schema.Struct({ ...CommandFields, action: Schema.Literal("revise"), proposalId: Id }),
  Schema.Struct({ ...CommandFields, action: Schema.Literal("cancel"), executionId: Id }),
  Schema.Struct({ ...CommandFields, action: Schema.Literal("withdrawExecution"), executionId: Id }),
  Schema.Struct({
    ...CommandFields,
    action: Schema.Literal("retry"),
    executionId: Schema.optional(Id),
  }),
]);
export type ProjectBriefCommand = typeof ProjectBriefCommand.Type;
export const ProjectBriefPublishInput = Schema.Struct({
  requestId: Id,
  projectId: ProjectId,
  synthesisId: Id,
  sourceDigest: Id,
  summary: Text,
  proposals: Schema.Array(ProjectBriefProposalDraft).check(Schema.isMaxLength(20)),
});
export type ProjectBriefPublishInput = typeof ProjectBriefPublishInput.Type;
export const ProjectBriefReportInput = Schema.Struct({
  requestId: Id,
  projectId: ProjectId,
  executionId: Id,
  summary: Text,
  artifactPaths: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)),
  ).check(Schema.isMaxLength(20)),
});
export type ProjectBriefReportInput = typeof ProjectBriefReportInput.Type;
export class ProjectBriefError extends Schema.TaggedError<ProjectBriefError>()(
  "ProjectBriefError",
  {
    code: Schema.Literals([
      "conflict",
      "invalid_request",
      "stale_sources",
      "forbidden",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}
