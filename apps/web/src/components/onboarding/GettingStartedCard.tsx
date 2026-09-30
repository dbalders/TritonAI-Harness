import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CircleIcon,
  LightbulbIcon,
  LockIcon,
  PartyPopperIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import {
  GETTING_STARTED_CHAPTERS,
  type GettingStartedStepView,
} from "~/onboarding/gettingStarted.logic";
import {
  completeGettingStartedSteps,
  setGettingStartedHidden,
  useGettingStartedState,
  useOpenLatestConversation,
} from "~/onboarding/gettingStarted";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface GettingStartedCardProps {
  /** Puts a step's example in the composer so the person can edit and send it. */
  readonly onFillComposer: (stepId: string, prompt: string) => void;
}

/**
 * Finishes "Connect your email and calendar" once a plugin that needs a
 * sign-in reports connected. Checks when shown and whenever the window regains
 * focus, which is when someone returns from signing in.
 */
function useConnectedToolDetection(enabled: boolean): void {
  const environmentId = usePrimaryEnvironmentId();
  const listIntegrations = useAtomCommand(serverEnvironment.listIntegrations, {
    reportFailure: false,
  });

  useEffect(() => {
    if (!enabled || environmentId === null) return;
    let cancelled = false;
    const check = async () => {
      const result = await listIntegrations({ environmentId, input: {} });
      if (cancelled || result._tag === "Failure") return;
      const connected = result.value.integrations.some(
        (integration) =>
          integration.enabled &&
          integration.requiresConnection &&
          integration.connectionState === "connected",
      );
      if (connected) completeGettingStartedSteps(["connect-tools"]);
    };
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, environmentId, listIntegrations]);
}

function StepIcon({ view }: { readonly view: GettingStartedStepView }) {
  if (view.status === "done") return <CheckIcon className="size-3 text-success-foreground" />;
  if (view.status === "locked") return <LockIcon className="size-3 text-muted-foreground/70" />;
  return <CircleIcon className="size-3 text-muted-foreground/70" />;
}

const MAIN_CHAPTERS = GETTING_STARTED_CHAPTERS.filter((chapter) => !chapter.optional);

export function GettingStartedCard({ onFillComposer }: GettingStartedCardProps) {
  const guide = useGettingStartedState();
  const navigate = useNavigate();
  const openLatestConversation = useOpenLatestConversation();
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const chosen =
    guide.steps.find((view) => view.step.id === selectedStepId && view.status !== "done") ?? null;
  // Once the main quest is done the card celebrates until a side quest is chosen.
  const selected =
    chosen ??
    (guide.isComplete
      ? null
      : (guide.nextStep ??
        guide.steps.find((view) => !view.optional && view.status === "locked") ??
        null));

  useConnectedToolDetection(
    !guide.hidden &&
      guide.steps.some((view) => view.step.id === "connect-tools" && view.status === "available"),
  );

  if (guide.hidden) return null;

  const progressPercent = Math.round((guide.completedCount / guide.total) * 100);
  const selectedChapter = selected
    ? (GETTING_STARTED_CHAPTERS.find((chapter) => chapter.id === selected.step.chapter) ?? null)
    : null;
  const chapterLabel = selectedChapter
    ? selectedChapter.optional
      ? "Side quest · optional"
      : `Chapter ${MAIN_CHAPTERS.indexOf(selectedChapter) + 1} of ${MAIN_CHAPTERS.length} · ${selectedChapter.title}`
    : null;
  const chapterSteps = selectedChapter
    ? guide.steps.filter((view) => view.step.chapter === selectedChapter.id)
    : guide.steps.filter((view) => view.optional);

  const selectChapter = (chapterId: string) => {
    const steps = guide.steps.filter((view) => view.step.chapter === chapterId);
    const target =
      steps.find((view) => view.status === "available") ??
      steps.find((view) => view.status === "locked");
    if (target) setSelectedStepId(target.step.id);
  };

  const runAction = (view: GettingStartedStepView) => {
    const { action } = view.step;
    switch (action.kind) {
      case "prompt":
        onFillComposer(view.step.id, action.prompt);
        return;
      case "ideas":
        return;
      case "open-latest-thread":
        void openLatestConversation?.();
        return;
      case "open-plugins":
        void navigate({ to: "/settings/plugins" });
        return;
      case "acknowledge":
        completeGettingStartedSteps([view.step.id]);
        return;
    }
  };

  return (
    <section
      aria-label="Getting started"
      className="mx-auto mt-3 max-h-[calc(45dvh+2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border/60 bg-card/70 p-4 text-left shadow-xs/5 backdrop-blur-sm"
    >
      <header className="flex items-center gap-3">
        <SparklesIcon className="size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground text-sm">Getting started</p>
          {chapterLabel ? (
            <p className="truncate text-muted-foreground text-xs">{chapterLabel}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {guide.completedCount} of {guide.total}
          </span>
          <div
            role="progressbar"
            aria-label="Getting started progress"
            aria-valuemin={0}
            aria-valuemax={guide.total}
            aria-valuenow={guide.completedCount}
            className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Hide getting started"
                  onClick={() => setGettingStartedHidden(true)}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Hide. Reopen it from the sidebar or Settings.</TooltipPopup>
          </Tooltip>
        </div>
      </header>

      {selected === null ? (
        <div className="mt-3 flex items-start gap-3">
          <PartyPopperIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">You finished getting started</p>
            <p className="mt-1 text-muted-foreground text-sm">
              You can talk to the assistant, share files, connect your tools, use skills, and pick
              up where you left off. Try a side quest below, or keep bringing it real work.
            </p>
            <Button className="mt-3" size="sm" onClick={() => setGettingStartedHidden(true)}>
              Close the guide
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <h2 className="font-medium text-base text-foreground">{selected.step.title}</h2>
          <p className="mt-1 text-muted-foreground text-sm leading-relaxed">{selected.step.body}</p>
          {selected.status === "locked" ? (
            <p className="mt-2 flex items-center gap-1.5 text-muted-foreground text-xs">
              <LockIcon className="size-3.5 shrink-0" aria-hidden />
              {selected.lockedReason}
            </p>
          ) : selected.step.tip ? (
            <p className="mt-2 flex items-start gap-1.5 text-muted-foreground text-xs">
              <LightbulbIcon className="mt-px size-3.5 shrink-0" aria-hidden />
              {selected.step.tip}
            </p>
          ) : null}
          {selected.status === "available" && selected.step.action.kind === "ideas" ? (
            <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {selected.step.action.ideas.map((idea) => (
                <button
                  key={idea.label}
                  type="button"
                  onClick={() => onFillComposer(selected.step.id, idea.prompt)}
                  className="rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 text-left text-foreground text-xs transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {idea.label}
                </button>
              ))}
            </div>
          ) : null}
          {selected.status === "available" ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {selected.step.action.kind === "ideas" ? null : selected.step.action.kind ===
                  "open-latest-thread" && !openLatestConversation ? (
                <p className="text-muted-foreground text-xs">
                  Send a message first, then come back to reply.
                </p>
              ) : (
                <Button size="sm" onClick={() => runAction(selected)}>
                  {selected.step.action.label}
                </Button>
              )}
              {selected.step.settingsLink ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (selected.step.settingsLink)
                      void navigate({ to: selected.step.settingsLink.to });
                  }}
                >
                  {selected.step.settingsLink.label}
                </Button>
              ) : null}
              {selected.step.completion !== "acknowledge" ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  onClick={() => {
                    setSelectedStepId(null);
                    completeGettingStartedSteps([selected.step.id]);
                  }}
                >
                  {selected.optional ? "Mark as done" : "Skip this step"}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <nav className="mt-4 flex flex-wrap items-center gap-1.5" aria-label="Chapters">
        {GETTING_STARTED_CHAPTERS.map((chapter) => {
          const steps = guide.steps.filter((view) => view.step.chapter === chapter.id);
          const done = steps.filter((view) => view.status === "done").length;
          const current = chapter.id === (selectedChapter?.id ?? "side-quests");
          return (
            <button
              key={chapter.id}
              type="button"
              aria-current={current ? "true" : undefined}
              onClick={() => selectChapter(chapter.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                current
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {done === steps.length ? (
                <CheckIcon className="size-3 text-success-foreground" aria-hidden />
              ) : null}
              {chapter.title}
              <span className="text-muted-foreground tabular-nums">
                {done}/{steps.length}
              </span>
            </button>
          );
        })}
      </nav>
      <ol className="mt-2 flex flex-wrap gap-1.5" aria-label="Steps">
        {chapterSteps.map((view) => (
          <li key={view.step.id}>
            <button
              type="button"
              disabled={view.status === "done"}
              aria-current={view.step.id === selected?.step.id ? "step" : undefined}
              onClick={() => setSelectedStepId(view.step.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors",
                "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                view.step.id === selected?.step.id
                  ? "border-primary/50 bg-primary/8 text-foreground"
                  : "border-border/60 text-muted-foreground hover:text-foreground",
                view.status === "done" && "cursor-default line-through opacity-70",
              )}
            >
              <StepIcon view={view} />
              <span>{view.step.title}</span>
              <span className="sr-only">
                {view.status === "done" ? "(done)" : view.status === "locked" ? "(locked)" : ""}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * A one-line reminder above the composer inside a conversation, shown while
 * the next step is something done by replying there.
 */
export function GettingStartedThreadTracker() {
  const guide = useGettingStartedState();
  if (guide.hidden || guide.nextStep?.step.completion !== "follow-up") return null;
  return (
    <div
      role="status"
      className="mb-2 flex items-center gap-2 rounded-xl border border-border/60 bg-popover/90 px-3 py-2 text-sm shadow-xs/5"
    >
      <SparklesIcon className="size-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 text-muted-foreground">
        <span className="font-medium text-foreground">{guide.nextStep.step.title}:</span> type a
        reply below. {guide.nextStep.step.tip}
      </p>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Hide getting started"
        onClick={() => setGettingStartedHidden(true)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
