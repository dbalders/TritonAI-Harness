import type { GettingStartedChapterId } from "@t3tools/contracts";
import { BookOpenIcon } from "lucide-react";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useGettingStarted, updateGettingStarted } from "../../onboarding/gettingStartedState";
import { Button } from "../ui/button";

const HINTS: Partial<Record<GettingStartedChapterId, { title: string; description: string }>> = {
  connect: {
    title: "Connect the account you use for work",
    description:
      "Find Microsoft 365 or Google Workspace, review its Access section, and connect on the provider's page. The guide checks for an available email-reading capability.",
  },
  "connected-work": {
    title: "Check your account and access",
    description:
      "Your email-reading capability must be available. Reopen your chapters to prepare a small read-only email request.",
  },
  ideas: {
    title: "Find a useful request ready to review",
    description:
      "Choose an idea and read what it is based on. Open draft prepares its message without sending it. You can edit it, then send when ready.",
  },
  "computer-use": {
    title: "Choose whether to enable computer use",
    description:
      "This optional feature can see and control desktop apps. Review each permission and the readiness shown below. You can leave it off and return later.",
  },
};

export function GettingStartedContextHint({
  chapters,
}: {
  chapters: ReadonlyArray<GettingStartedChapterId>;
}) {
  const state = useGettingStarted();
  const environmentId = usePrimaryEnvironmentId();
  const hint = HINTS[state.activeChapter];
  if (
    !hint ||
    !state.startedAt ||
    state.paused ||
    state.open ||
    state.environmentId !== environmentId ||
    !chapters.includes(state.activeChapter)
  )
    return null;
  return (
    <section
      aria-label="Getting started hint"
      className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4"
    >
      <BookOpenIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{hint.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint.description}</p>
        <div className="mt-2 flex gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void updateGettingStarted({ type: "select", chapter: state.activeChapter })
            }
          >
            Your chapters
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => void updateGettingStarted({ type: "pause" })}
          >
            Pause guidance
          </Button>
        </div>
      </div>
    </section>
  );
}
