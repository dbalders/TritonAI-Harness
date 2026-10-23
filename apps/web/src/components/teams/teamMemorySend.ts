import type { ComposerThreadDraftState } from "../../composerDraftStore";

interface TeamMemorySendSnapshot {
  readonly editorIdentity: object | null;
  readonly routeKey: string | null;
  readonly accountRevision: number;
  readonly prompt: string;
  readonly references: readonly string[];
  readonly draft: ComposerThreadDraftState | null;
}

const contentKeys = [
  "images",
  "files",
  "terminalContexts",
  "previewAnnotations",
  "reviewComments",
  "threadContexts",
] as const;
const sameItems = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function sameSnapshot(before: TeamMemorySendSnapshot, after: TeamMemorySendSnapshot): boolean {
  return (
    before.editorIdentity !== null &&
    before.editorIdentity === after.editorIdentity &&
    before.routeKey !== null &&
    before.routeKey === after.routeKey &&
    before.accountRevision === after.accountRevision &&
    before.prompt === after.prompt &&
    sameItems(before.references.toSorted(), after.references.toSorted()) &&
    contentKeys.every((key) => sameItems(before.draft?.[key] ?? [], after.draft?.[key] ?? []))
  );
}

/** Checks the payload the user is still composing; render/default-state churn is immaterial. */
export async function verifyTeamMemorySend(input: {
  readonly readCurrent: () => TeamMemorySendSnapshot;
  readonly verify: (references: readonly string[]) => Promise<string | null>;
}): Promise<
  | { readonly status: "ready" }
  | { readonly status: "stale" }
  | { readonly status: "denied"; readonly problem: string }
> {
  const before = input.readCurrent();
  if (before.editorIdentity === null || before.routeKey === null) return { status: "stale" };
  const problem = await input.verify(before.references);
  if (!sameSnapshot(before, input.readCurrent())) return { status: "stale" };
  return problem === null ? { status: "ready" } : { status: "denied", problem };
}
