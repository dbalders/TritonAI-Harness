import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  threadContext?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface DailyMemoryGenerationInput {
  /** Working directory for the generation process. Nothing in it is read. */
  cwd: string;
  /** The local day being summarized, `YYYY-MM-DD`. */
  day: string;
  projectNames: ReadonlyArray<string>;
  activity: string;
  inboxNotes: string;
  modelSelection: ModelSelection;
}

export interface DailyMemoryGenerationResult {
  overview: string;
  projects: ReadonlyArray<{
    readonly project: string;
    readonly workedOn: ReadonlyArray<string>;
    readonly recent: string;
  }>;
  decisions: ReadonlyArray<string>;
  openLoops: ReadonlyArray<string>;
}

export interface IdeasGenerationInput {
  /** Working directory for the generation process. Nothing in it is read. */
  cwd: string;
  /** How many ideas to return at most. */
  count: number;
  /** Everything the model may draw on, already formatted and trimmed by the Ideas service. */
  context: string;
  modelSelection: ModelSelection;
  /** Limits suggestions to one project and also asks for a short project description. */
  project?: { readonly id: string; readonly title: string };
}

/** One idea as the model wrote it, before the Ideas service checks it against the context. */
export interface GeneratedIdea {
  /** The context reference the idea is mainly about, such as `thread:<id>`. */
  readonly ref: string;
  /** A few words naming what the idea does; tells apart ideas about the same reference. */
  readonly topic: string;
  readonly sources: ReadonlyArray<string>;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly action: "new-thread" | "resume-thread";
  /** A project id from the context, or empty. */
  readonly projectId: string;
  readonly prompt: string;
}

export interface IdeasGenerationResult {
  ideas: ReadonlyArray<GeneratedIdea>;
  description?: string;
}

/** Commit, change request, branch, and title generation backed by one provider instance. */
export interface ProviderTextGeneration {
  /** Summarize an opt-in memory day; supplied by Codex. */
  readonly generateDailyMemory?: (
    input: DailyMemoryGenerationInput,
  ) => Effect.Effect<DailyMemoryGenerationResult, TextGenerationError>;
  /** Suggest Ideas from the context assembled by the server; supplied by Codex. */
  readonly generateIdeas?: (
    input: IdeasGenerationInput,
  ) => Effect.Effect<IdeasGenerationResult, TextGenerationError>;
  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;
}
