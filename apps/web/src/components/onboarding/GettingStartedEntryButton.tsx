import { BookOpenIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "../ui/button";

export interface GettingStartedEntryButtonProps {
  onClick: () => void;
  progressLabel?: string;
  /** Whether the host currently has the coach open. */
  active?: boolean;
}

/** Persistent entry point; the host decides whether clicking starts or resumes the guide. */
export function GettingStartedEntryButton({
  onClick,
  progressLabel,
  active = false,
}: GettingStartedEntryButtonProps) {
  return (
    <div className="grid min-w-0">
      <Button
        variant={active ? "secondary" : "ghost"}
        size="sm-multiline"
        aria-expanded={active}
        onClick={onClick}
      >
        <span className="flex w-full min-w-0 items-center gap-2.5 py-1.5 text-left">
          <BookOpenIcon aria-hidden="true" />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="block text-xs font-medium leading-5">Getting started</span>
            <span className="mt-0.5 block text-2xs font-normal leading-4 text-muted-foreground">
              {progressLabel || "Explore at your own pace"}
            </span>
          </span>
          <ChevronRightIcon aria-hidden="true" />
        </span>
      </Button>
    </div>
  );
}
