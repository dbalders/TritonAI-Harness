import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Where an idea came from, which is also the heading it is listed under.
 * `continue` and `projects` come from the user's own work; `tools`, `new`, and
 * `starter` help them discover what TritonAI can do.
 */
export const IdeaSection = Schema.Literals(["continue", "projects", "tools", "new", "starter"]);
export type IdeaSection = typeof IdeaSection.Type;

export const IdeaSourceKind = Schema.Literals([
  "thread",
  "note",
  "file",
  "plugin",
  "skill",
  "starter",
]);
export type IdeaSourceKind = typeof IdeaSourceKind.Type;

/** Something real the idea is based on, shown under "Why this?". */
export const IdeaSource = Schema.Struct({
  kind: IdeaSourceKind,
  label: TrimmedNonEmptyString,
});
export type IdeaSource = typeof IdeaSource.Type;

/** What accepting the idea does. Either way it opens a draft; nothing runs until the user sends it. */
export const IdeaAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("new-thread"),
    /** Null when the idea has no project of its own; the client picks the default one. */
    projectId: Schema.NullOr(ProjectId),
    prompt: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("resume-thread"),
    threadId: ThreadId,
    prompt: TrimmedNonEmptyString,
  }),
]);
export type IdeaAction = typeof IdeaAction.Type;

export const Idea = Schema.Struct({
  id: TrimmedNonEmptyString,
  section: IdeaSection,
  /** A single emoji. */
  icon: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  body: TrimmedNonEmptyString,
  sources: Schema.Array(IdeaSource),
  action: IdeaAction,
  createdAt: IsoDateTime,
  /** Set once the user opened its draft; the idea stays listed until the draft is sent. */
  openedAt: Schema.NullOr(IsoDateTime),
  /**
   * The threads a new-thread idea's drafts become when sent, one per client that
   * opened it, so reopening finds that client's draft.
   */
  draftThreadIds: Schema.Array(ThreadId),
  snoozedUntil: Schema.NullOr(IsoDateTime),
});
export type Idea = typeof Idea.Type;

export const IdeasGenerationState = Schema.Literals(["idle", "generating", "error"]);
export type IdeasGenerationState = typeof IdeasGenerationState.Type;

export const IdeasSnapshot = Schema.Struct({
  ideas: Schema.Array(Idea),
  snoozed: Schema.Array(Idea),
  /** Ideas added since the user last opened the Ideas page. */
  unseenCount: NonNegativeInt,
  state: IdeasGenerationState,
  message: Schema.NullOr(TrimmedNonEmptyString),
  generatedAt: Schema.NullOr(IsoDateTime),
});
export type IdeasSnapshot = typeof IdeasSnapshot.Type;

/**
 * Opened records a draft; dismissed allows a later suggestion; rejected never returns.
 * Less-like-this reduces its section, snoozed hides until snoozedUntil, and restored undoes hiding.
 */
export const IdeaFeedbackKind = Schema.Literals([
  "opened",
  "dismissed",
  "rejected",
  "less-like-this",
  "snoozed",
  "restored",
]);
export type IdeaFeedbackKind = typeof IdeaFeedbackKind.Type;

export const IdeasFeedbackInput = Schema.Struct({
  ideaId: TrimmedNonEmptyString,
  kind: IdeaFeedbackKind,
  snoozedUntil: Schema.optional(IsoDateTime),
  /** With `opened`: the thread id of the draft the idea was opened in. */
  draftThreadId: Schema.optional(ThreadId),
});
export type IdeasFeedbackInput = typeof IdeasFeedbackInput.Type;

export class IdeasError extends Schema.TaggedError<IdeasError>()("IdeasError", {
  message: TrimmedNonEmptyString,
}) {}

/**
 * Text a message sent from an idea's draft still contains after the user fills
 * in its `[placeholders]`: the start of the prompt's longest placeholder-free
 * run. Empty when the prompt is all placeholders.
 */
export function ideaPromptSnippet(prompt: string): string {
  const runs = prompt
    .replace(/\s+/gu, " ")
    .split(/\[[^\]]*\]/u)
    .map((run) => run.trim());
  const longest = runs.reduce((best, run) => (run.length > best.length ? run : best), "");
  return longest.slice(0, 48).trim();
}
