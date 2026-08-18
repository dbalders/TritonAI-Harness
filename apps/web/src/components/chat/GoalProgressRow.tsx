import type { ThreadGoal } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleGaugeIcon,
  EllipsisIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

const statusPresentation: Record<
  ThreadGoal["status"],
  { readonly label: string; readonly tone: string; readonly icon: typeof TargetIcon }
> = {
  active: { label: "Pursuing goal", tone: "text-primary", icon: TargetIcon },
  paused: { label: "Paused goal", tone: "text-warning", icon: PauseIcon },
  blocked: { label: "Goal stalled", tone: "text-destructive", icon: CircleGaugeIcon },
  usageLimited: { label: "Goal usage limited", tone: "text-warning", icon: CircleGaugeIcon },
  budgetLimited: { label: "Goal limited", tone: "text-warning", icon: CircleGaugeIcon },
  complete: { label: "Goal complete", tone: "text-success", icon: CircleCheckIcon },
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function formatUpdatedAt(updatedAt: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 1_000));
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 60) return "Updated just now";
  if (elapsedSeconds < 3_600) return `Updated ${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `Updated ${Math.floor(elapsedSeconds / 3_600)}h ago`;
  return `Updated ${Math.floor(elapsedSeconds / 86_400)}d ago`;
}

export function GoalProgressRow(props: {
  goal: ThreadGoal;
  pending: boolean;
  onPause: () => void;
  onResume: () => void;
  onEdit: () => void;
  onClear: () => void;
  className?: string;
}) {
  const { goal } = props;
  useNowMinute();
  const presentation = statusPresentation[goal.status];
  const StatusIcon = presentation.icon;
  const usage = [
    goal.tokenBudget === null
      ? goal.tokensUsed > 0
        ? `${compactNumber.format(goal.tokensUsed)} tokens`
        : null
      : `${compactNumber.format(goal.tokensUsed)} / ${compactNumber.format(goal.tokenBudget)} tokens`,
    goal.timeUsedSeconds > 0 ? formatDuration(goal.timeUsedSeconds) : null,
  ].filter((value): value is string => value !== null);

  return (
    <section
      className={cn("relative z-0 mx-auto -mb-px w-full max-w-3xl", props.className)}
      aria-label="Thread goal"
      aria-busy={props.pending}
    >
      <div className="flex min-h-14 items-center gap-3 rounded-t-[18px] border border-b-0 border-border/70 bg-background/92 px-3.5 pb-3 pt-2.5 shadow-xs backdrop-blur-sm motion-safe:transition-colors motion-safe:duration-200">
        <StatusIcon className={cn("size-4 shrink-0", presentation.tone)} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={cn("shrink-0 text-xs font-semibold", presentation.tone)}
              role="status"
              aria-live="polite"
            >
              {presentation.label}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {formatUpdatedAt(goal.updatedAt)}
            </span>
          </div>
          <p className="line-clamp-2 text-xs leading-4 text-foreground" title={goal.objective}>
            {goal.objective}
          </p>
          {usage.length > 0 ? (
            <p className="truncate text-[10px] text-muted-foreground/75">{usage.join(" · ")}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {goal.status === "active" ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={props.pending}
              aria-label="Pause goal"
              onClick={props.onPause}
              className="gap-1.5"
            >
              <PauseIcon aria-hidden="true" />
              Pause
            </Button>
          ) : goal.status !== "complete" ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={props.pending}
              aria-label="Resume goal"
              onClick={props.onResume}
              className="gap-1.5"
            >
              <PlayIcon aria-hidden="true" />
              Resume
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={props.pending}
              aria-label="Goal actions"
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <EllipsisIcon className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={props.onEdit}>
                <PencilIcon aria-hidden="true" />
                Edit goal
              </DropdownMenuItem>
              <DropdownMenuItem onClick={props.onClear} className="text-destructive">
                <Trash2Icon aria-hidden="true" />
                Clear goal
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </section>
  );
}
