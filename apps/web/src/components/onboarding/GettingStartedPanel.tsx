import {
  BookOpenIcon,
  CheckIcon,
  ChevronDownIcon,
  ListIcon,
  LocateFixedIcon,
  PauseIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

export interface Chapter {
  id: string;
  title: string;
  description: string;
  status: "available" | "complete" | "later";
  disabled?: boolean;
}

export interface GettingStartedPanelProps {
  chapters: readonly Chapter[];
  activeChapterId: string;
  title: string;
  description: string;
  progressLabel: string;
  children?: ReactNode;
  target?: string | null;
  onSelectChapter: (id: string) => void;
  onPause: () => void;
  onRestart: () => void;
  onClose: () => void;
}

/** Host hooks supported by the coach. Unknown strings never become CSS selectors. */
const GETTING_STARTED_TARGETS = [
  "new-thread",
  "composer",
  "connections",
  "skills",
  "ideas",
  "computer-use",
  "settings",
  "projects",
] as const;

const focusableSelector =
  'a[href], button, input:not([type="hidden"]), select, textarea, [contenteditable="true"], [tabindex]';

function isVisible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const visibility = window.getComputedStyle(element).visibility;
  return (
    visibility !== "hidden" && visibility !== "collapse" && element.getClientRects().length > 0
  );
}

function isEnabled(element: HTMLElement): boolean {
  return !element.matches(":disabled") && !element.closest('[aria-disabled="true"]');
}

/** A nonmodal coach. The host owns placement, progress, navigation, and real actions. */
export function GettingStartedPanel({
  chapters,
  activeChapterId,
  title,
  description,
  progressLabel,
  children,
  target,
  onSelectChapter,
  onPause,
  onRestart,
  onClose,
}: GettingStartedPanelProps) {
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  const [chaptersExpanded, setChaptersExpanded] = useState(false);
  const [targetNotice, setTargetNotice] = useState<{
    chapterId: string;
    target: string | null | undefined;
    message: string;
  } | null>(null);
  const knownTarget = GETTING_STARTED_TARGETS.find((candidate) => candidate === target);
  const selector = knownTarget ? `[data-getting-started-target="${knownTarget}"]` : null;
  const notice =
    targetNotice?.chapterId === activeChapterId && targetNotice.target === target
      ? targetNotice.message
      : null;

  function showTarget() {
    if (!selector) return;

    function explain(message: string) {
      setTargetNotice({ chapterId: activeChapterId, target, message });
    }

    const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const visibleMatches = matches.filter(isVisible);
    const element = visibleMatches.find(isEnabled);

    if (!element) {
      explain(
        visibleMatches.length > 0
          ? "That control is unavailable right now. You can keep exploring or choose another chapter."
          : "That part of the app is not visible here yet. Use this chapter’s actions, then try Show me again.",
      );
      return;
    }

    const focusTarget = element.matches(focusableSelector)
      ? element
      : (Array.from(element.querySelectorAll<HTMLElement>(focusableSelector)).find(
          (candidate) => isVisible(candidate) && isEnabled(candidate),
        ) ?? element);
    const temporaryTabIndex = focusTarget.tabIndex < 0 && !focusTarget.hasAttribute("tabindex");

    // This is the only focus/scroll path. Highlighting and chapter changes never move focus.
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
    if (temporaryTabIndex) focusTarget.setAttribute("tabindex", "-1");
    focusTarget.focus({ preventScroll: true });

    if (temporaryTabIndex) {
      const restoreTabIndex = () => {
        if (focusTarget.getAttribute("tabindex") === "-1") focusTarget.removeAttribute("tabindex");
      };
      if (document.activeElement === focusTarget) {
        focusTarget.addEventListener("blur", restoreTabIndex, { once: true });
      } else {
        restoreTabIndex();
      }
    }

    explain(
      document.activeElement === focusTarget
        ? "You’re at the highlighted area. Continue there when you’re ready."
        : "The area is highlighted. Select its control when you’re ready.",
    );
  }

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="w-full max-w-[calc(100vw-24px)] max-h-[min(640px,calc(100dvh-5rem))] overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover text-popover-foreground shadow-xl"
      data-getting-started-panel=""
    >
      {/* Targets belong to the host DOM, so this scoped, allowlisted rule lives with the coach. */}
      {expanded && selector && (
        <style>{`${selector} { outline: 2px solid var(--ring); outline-offset: 3px; scroll-margin: 24px; }`}</style>
      )}
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-popover px-4 py-3">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary"
          >
            <BookOpenIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <h2 id={`${id}-heading`} className="text-sm font-semibold">
              Getting started
            </h2>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{progressLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CollapsibleTrigger
              aria-label={expanded ? "Collapse guidance" : "Expand guidance"}
              title={expanded ? "Collapse guidance" : "Expand guidance"}
              render={<Button variant="ghost-muted" size="icon-lg" />}
            >
              <ChevronDownIcon aria-hidden="true" className={cn(!expanded && "rotate-180")} />
            </CollapsibleTrigger>
            <Button
              variant="ghost-muted"
              size="icon-lg"
              aria-label="Close getting started"
              title="Close getting started"
              onClick={onClose}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </div>
        </div>

        <CollapsiblePanel animate={false}>
          <div className="px-4 pb-4">
            <div aria-hidden="true" className="mb-4 flex gap-1">
              {chapters.map((chapter) => (
                <span
                  key={chapter.id}
                  className={cn(
                    "h-1 min-w-0 flex-1 rounded-full",
                    chapter.status === "complete"
                      ? "bg-primary"
                      : chapter.id === activeChapterId
                        ? "bg-primary/45"
                        : "bg-muted",
                  )}
                />
              ))}
            </div>

            <div className="rounded-lg border border-primary/15 bg-primary/4 px-3.5 py-3 [overflow-wrap:anywhere]">
              <p className="mb-1.5 text-2xs font-medium text-muted-foreground">Your next step</p>
              <h3 className="text-sm font-semibold leading-5">{title}</h3>
              <p className="mt-1.5 text-sm leading-5 text-muted-foreground">{description}</p>
              {target && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selector}
                    aria-describedby={`${id}-target-notice`}
                    onClick={showTarget}
                  >
                    <LocateFixedIcon aria-hidden="true" />
                    Show me
                  </Button>
                  <span className="text-xs text-muted-foreground">Go to the highlighted area</span>
                </div>
              )}
              <p
                id={`${id}-target-notice`}
                role="status"
                aria-atomic="true"
                className="mt-2 text-xs leading-5 text-muted-foreground empty:hidden"
              >
                {target && !selector
                  ? "This chapter’s control is not available here. You can use the actions below or explore another chapter."
                  : notice}
              </p>
            </div>

            {children != null && (
              <div className="mt-3 grid min-w-0 gap-2 [overflow-wrap:anywhere]">{children}</div>
            )}

            <div className="mt-4">
              <Collapsible open={chaptersExpanded} onOpenChange={setChaptersExpanded}>
                <div className="flex items-center justify-between gap-2">
                  <CollapsibleTrigger render={<Button variant="ghost-muted" size="sm" />}>
                    <ListIcon aria-hidden="true" />
                    Chapters
                    <span className="text-xs tabular-nums">{chapters.length}</span>
                    <ChevronDownIcon
                      aria-hidden="true"
                      className={cn(chaptersExpanded && "rotate-180")}
                    />
                  </CollapsibleTrigger>
                  <span className="text-xs text-muted-foreground">At your own pace</span>
                </div>
                <CollapsiblePanel animate={false}>
                  <nav aria-label="Getting started chapters" className="pt-2">
                    <ol className="space-y-1">
                      {chapters.map((chapter, index) => {
                        const selected = chapter.id === activeChapterId;
                        const complete = chapter.status === "complete";
                        return (
                          <li key={chapter.id}>
                            {/* A chapter is a navigation row, rather than a toolbar button. */}
                            <button
                              type="button"
                              aria-current={selected ? "step" : undefined}
                              disabled={chapter.disabled}
                              onClick={() => onSelectChapter(chapter.id)}
                              className={cn(
                                "grid min-h-12 w-full grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5 rounded-lg border px-2.5 py-2.5 text-left [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60",
                                selected
                                  ? "border-primary/20 bg-primary/6"
                                  : "border-transparent enabled:cursor-pointer enabled:hover:bg-accent",
                              )}
                            >
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "flex size-6 items-center justify-center rounded-full text-2xs font-medium tabular-nums",
                                  selected
                                    ? "bg-primary text-primary-foreground"
                                    : complete
                                      ? "bg-success/10 text-success-foreground"
                                      : "bg-muted text-muted-foreground",
                                )}
                              >
                                {complete ? <CheckIcon className="size-3.5" /> : index + 1}
                              </span>
                              <span className="min-w-0">
                                <span className="sr-only">Chapter {index + 1}: </span>
                                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                  <span className="text-xs font-medium leading-5">
                                    {chapter.title}
                                  </span>
                                  {complete ? (
                                    <span className="text-2xs text-muted-foreground">Complete</span>
                                  ) : chapter.status === "later" ? (
                                    <span className="text-2xs text-muted-foreground">Later</span>
                                  ) : null}
                                </span>
                                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                                  {chapter.description}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </nav>
                </CollapsiblePanel>
              </Collapsible>
            </div>
          </div>

          <div className="border-t border-border/70 px-4 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={onPause}>
                <PauseIcon aria-hidden="true" />
                Pause guide
              </Button>
              <Button variant="ghost-muted" size="sm" onClick={onRestart}>
                <RotateCcwIcon aria-hidden="true" />
                Start again
              </Button>
            </div>
            <p className="mt-1.5 px-2.5 text-2xs leading-4 text-muted-foreground">
              Resume anytime from Getting started.
            </p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
