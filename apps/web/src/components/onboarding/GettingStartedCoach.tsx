import type { ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleIcon, LockIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  GETTING_STARTED_CHAPTERS,
  GETTING_STARTED_STEPS,
  resolveGettingStartedThreadNudge,
  type GettingStartedState,
  type GettingStartedStepView,
} from "~/onboarding/gettingStarted.logic";
import {
  completeGettingStartedSteps,
  setGettingStartedHidden,
  useGettingStartedQuestStep,
  useGettingStartedState,
  useJustCompletedGettingStartedSteps,
  useOpenLatestConversation,
  useStartGettingStartedStepInNewDraft,
} from "~/onboarding/gettingStarted";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

interface GettingStartedCoachProps {
  /** Above the composer of a new, empty conversation, or inside a conversation. */
  readonly where: "hero" | "thread";
  /** The draft or conversation the coach is shown with. */
  readonly threadId: string | null;
  /** Where "Next" opens a fresh conversation. */
  readonly projectRef: ScopedProjectRef | null;
  /** Puts a step's example in this composer so the person can edit and send it. */
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

function stepNumber(guide: GettingStartedState, view: GettingStartedStepView): number | null {
  if (view.optional) return null;
  return guide.steps.filter((candidate) => !candidate.optional).indexOf(view) + 1;
}

function StepTag({ guide, view }: { guide: GettingStartedState; view: GettingStartedStepView }) {
  const number = stepNumber(guide, view);
  return (
    <span className="me-1.5 rounded-md bg-primary/10 px-1.5 py-0.5 align-[1px] font-semibold text-[10.5px] text-primary uppercase tracking-wide">
      {number === null ? "Side quest" : `Step ${number}`}
    </span>
  );
}

function Chip(props: { onClick: () => void; children: ReactNode }) {
  return (
    <Button size="xs" variant="outline" className="rounded-full" onClick={props.onClick}>
      {props.children}
    </Button>
  );
}

function AllSteps(props: {
  guide: GettingStartedState;
  /** Above the composer the list grows upward, so it gets less room. */
  short: boolean;
  current: GettingStartedStepView | null;
  onSelect: (stepId: string) => void;
}) {
  const { guide, current } = props;
  return (
    <div
      className={cn(
        "mt-3 overflow-y-auto border-border/60 border-t pt-3",
        props.short ? "max-h-[24dvh]" : "max-h-[36dvh]",
      )}
    >
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {GETTING_STARTED_CHAPTERS.map((chapter) => {
          const steps = guide.steps.filter((view) => view.step.chapter === chapter.id);
          if (steps.length === 0) return null;
          return (
            <div key={chapter.id}>
              <p className="mb-1 font-semibold text-[11px] text-muted-foreground uppercase tracking-wide">
                {chapter.title}
                {chapter.optional ? (
                  <span className="ms-1 font-normal normal-case tracking-normal">optional</span>
                ) : null}
              </p>
              {steps.map((view) => (
                <button
                  key={view.step.id}
                  type="button"
                  disabled={view.status === "done"}
                  onClick={() => props.onSelect(view.step.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px]",
                    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                    view.step.id === current?.step.id
                      ? "bg-primary/8 font-medium text-foreground"
                      : "text-foreground/80 hover:bg-accent",
                    view.status === "done" && "cursor-default text-muted-foreground line-through",
                  )}
                >
                  {view.status === "done" ? (
                    <CheckIcon className="size-3.5 shrink-0 text-success-foreground" />
                  ) : view.status === "locked" ? (
                    <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  {view.step.title}
                  <span className="sr-only">
                    {view.status === "done" ? "(done)" : view.status === "locked" ? "(locked)" : ""}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {current && current.status === "available" && current.step.completion !== "acknowledge" ? (
        <button
          type="button"
          className="mt-3 text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
          onClick={() => completeGettingStartedSteps([current.step.id], { announce: false })}
        >
          Skip “{current.step.title}”
        </button>
      ) : null}
    </div>
  );
}

/**
 * The getting started guide, spoken as a chat bubble: it introduces each step
 * where the person types, celebrates a step right after they finish it, and
 * otherwise stays out of the way as a one-line "Next up" inside conversations.
 */
export function GettingStartedCoach({
  where,
  threadId,
  projectRef,
  onFillComposer,
}: GettingStartedCoachProps) {
  const guide = useGettingStartedState();
  const navigate = useNavigate();
  const openLatestConversation = useOpenLatestConversation();
  const startInNewDraft = useStartGettingStartedStepInNewDraft();
  const filledStepId = useGettingStartedQuestStep(where === "hero" ? threadId : null);
  const justCompleted = useJustCompletedGettingStartedSteps(where === "thread" ? threadId : null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useConnectedToolDetection(
    !guide.hidden &&
      guide.steps.some((view) => view.step.id === "connect-tools" && view.status === "available"),
  );

  if (guide.hidden) return null;

  const current =
    guide.steps.find((view) => view.step.id === selectedStepId && view.status !== "done") ??
    guide.nextStep;
  const nudge = where === "thread" ? resolveGettingStartedThreadNudge(guide, justCompleted) : null;
  if (nudge === "none" && !showAll) return null;

  const runStep = (view: GettingStartedStepView, prompt?: string) => {
    const { action } = view.step;
    setShowAll(false);
    if (action.kind === "prompt" || action.kind === "ideas") {
      const text = prompt ?? (action.kind === "prompt" ? action.prompt : "");
      if (where === "hero") onFillComposer(view.step.id, text);
      else if (projectRef) void startInNewDraft(projectRef, view.step.id, text);
      return;
    }
    if (action.kind === "open-latest-thread") void openLatestConversation?.();
    else if (action.kind === "open-plugins") void navigate({ to: "/settings/plugins" });
    else completeGettingStartedSteps([view.step.id], { announce: false });
  };

  const primaryButton = (view: GettingStartedStepView) => {
    const { action } = view.step;
    let label: string | null = null;
    if (action.kind === "prompt") {
      label = where === "thread" ? "Next" : filledStepId === view.step.id ? null : action.label;
    } else if (action.kind === "open-latest-thread") {
      label = where === "hero" && openLatestConversation ? action.label : null;
    } else if (action.kind !== "ideas") {
      label = action.label;
    }
    if (label === null) return null;
    return (
      <Button size="xs" className="rounded-full" onClick={() => runStep(view)}>
        {label}
      </Button>
    );
  };

  const hideButton = (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label="Hide getting started"
      title="Hide. Reopen it from the sidebar or Settings."
      onClick={() => setGettingStartedHidden(true)}
    >
      <XIcon />
    </Button>
  );

  if (nudge === "next-up" && current && !showAll) {
    const repliesHere = current.step.completion === "follow-up";
    return (
      <div
        role="status"
        className="mb-2 flex items-center gap-2 rounded-xl border border-border/60 bg-card/90 px-3 py-1.5 text-sm shadow-xs/5"
      >
        <SparklesIcon className="size-4 shrink-0 text-primary" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-muted-foreground">
          Next up: <span className="font-medium text-foreground">{current.step.title}</span>
          {repliesHere ? ". Reply below." : null}
        </p>
        {current.status === "available" && !repliesHere ? primaryButton(current) : null}
        <Button size="xs" variant="ghost-muted" onClick={() => setShowAll(true)}>
          All steps
        </Button>
        {hideButton}
      </div>
    );
  }

  const lastDone = GETTING_STARTED_STEPS.find((step) => step.id === justCompleted.at(-1));
  const lockedStep = guide.steps.find((view) => !view.optional && view.status === "locked");
  const intro =
    where === "thread"
      ? (lastDone?.doneLine ?? null)
      : guide.completedCount === 0
        ? "Hi! I'm your TritonAI assistant. Let's try a few real tasks together, one at a time."
        : null;

  let body: ReactNode;
  if (current) {
    const filled = where === "hero" && filledStepId === current.step.id;
    const line =
      current.status === "locked"
        ? current.lockedReason
        : filled && current.step.filledHint
          ? current.step.filledHint
          : current.step.summary;
    body = (
      <>
        <p className="leading-relaxed">
          <StepTag guide={guide} view={current} />
          <span className="font-medium">{current.step.title}.</span> {line}
        </p>
        {current.status === "available" && current.step.action.kind === "ideas" ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {current.step.action.ideas.map((idea) => (
              <Chip key={idea.label} onClick={() => runStep(current, idea.prompt)}>
                {idea.label}
              </Chip>
            ))}
          </div>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {current.status === "available" ? primaryButton(current) : null}
          {current.status === "available" && current.step.settingsLink ? (
            <Chip
              onClick={() => {
                if (current.step.settingsLink) void navigate({ to: current.step.settingsLink.to });
              }}
            >
              {current.step.settingsLink.label}
            </Chip>
          ) : null}
          <Chip onClick={() => setShowAll((open) => !open)}>
            {showAll ? "Hide steps" : "See all steps"}
          </Chip>
          <Chip onClick={() => setGettingStartedHidden(true)}>Not now</Chip>
        </div>
      </>
    );
  } else if (guide.isComplete) {
    body = (
      <>
        <p className="leading-relaxed">
          That's everything. You finished getting started 🎉 Side quests are there whenever you want
          more.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Chip onClick={() => setShowAll((open) => !open)}>
            {showAll ? "Hide side quests" : "See side quests"}
          </Chip>
          <Chip onClick={() => setGettingStartedHidden(true)}>Close the guide</Chip>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="leading-relaxed">
          <span className="font-medium">{lockedStep?.step.title}</span> unlocks tomorrow. Come back
          after a day of work and try it.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Chip onClick={() => setShowAll((open) => !open)}>
            {showAll ? "Hide steps" : "Try a side quest"}
          </Chip>
          <Chip onClick={() => setGettingStartedHidden(true)}>Not now</Chip>
        </div>
      </>
    );
  }

  return (
    <section
      aria-label="Getting started"
      className={cn("flex w-full items-start gap-3 text-left", where === "thread" && "mb-2")}
    >
      <span
        aria-hidden
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <SparklesIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border border-border/60 bg-card px-4 py-3 text-foreground text-sm shadow-xs/5">
        {intro ? <p className="mb-1.5 leading-relaxed">{intro}</p> : null}
        {body}
        {showAll ? (
          <AllSteps
            guide={guide}
            short={where === "hero"}
            current={current}
            onSelect={(stepId) => {
              setSelectedStepId(stepId);
              setShowAll(false);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
