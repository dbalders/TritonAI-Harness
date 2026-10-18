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
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
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
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
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
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  /** The layer's head in the checkout, null where it could not be fetched. */
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  /** A disposable checkout of the change's head. The model investigates it read-only. */
  cwd: string;
  number: number;
  title: string;
  /** The author's own description, which states intent the diff cannot. */
  description: string;
  baseBranch: string;
  /** The commit the change is measured from, present in `cwd`. */
  baseCommit: string;
  /**
   * What review already settled: resolved conversations, reduced to who raised what. The guide
   * leaves these alone rather than raising them again.
   */
  settledReview: string;
  /** The maintainer's preferences for guides (tone, emphasis, ordering). Empty for none. */
  instructions?: string | undefined;
  /**
   * The stack the change is a layer of, bottom first, when it is in one. Another layer's head is
   * fetched into `cwd` where the host served it, so the model can read across a seam.
   */
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

/** A guide as the model wrote it, before the server holds it to the change. */
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

  /**
   * Generate change request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /** Generate a concise thread title from a first message or thread history. */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /** Explain a change request to the maintainer deciding whether it lands. */
  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;
}
