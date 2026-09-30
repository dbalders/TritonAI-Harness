import { SparklesIcon } from "lucide-react";
import { memo } from "react";

import {
  useOpenGettingStartedGuide,
  useGettingStartedState,
} from "../../onboarding/gettingStarted";
import { useSidebar } from "../ui/sidebar";

/** Keeps the getting started guide one click away until it is finished or hidden. */
export const SidebarGettingStartedPill = memo(function SidebarGettingStartedPill() {
  const guide = useGettingStartedState();
  const openGuide = useOpenGettingStartedGuide();
  const { isMobile, setOpenMobile } = useSidebar();

  if (guide.hidden || guide.isComplete) return null;

  const percent = Math.round((guide.completedCount / guide.total) * 100);
  return (
    <button
      type="button"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void openGuide();
      }}
      className="flex w-full shrink-0 flex-col gap-1.5 rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-1.5 font-medium text-foreground text-xs">
        <SparklesIcon className="size-3.5 text-primary" aria-hidden />
        Getting started
        <span className="ml-auto text-muted-foreground tabular-nums">
          {guide.completedCount}/{guide.total}
        </span>
      </span>
      <span aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </span>
      {guide.nextStep ? (
        <span className="truncate text-[11px] text-muted-foreground">
          Next: {guide.nextStep.step.title}
        </span>
      ) : null}
    </button>
  );
});
