import type { MouseEvent, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ProjectFolderHeading({
  title,
  projectKey,
  expanded,
  onToggle,
  onOpen,
  canReorder = false,
  leading,
  children,
}: {
  title: string;
  projectKey: string;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
  canReorder?: boolean;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  const label = `${expanded ? "Collapse" : "Expand"} ${title} threads`;
  const Icon = expanded ? FolderOpenIcon : FolderIcon;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={label}
              onClick={onToggle}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:size-11",
                canReorder ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
              )}
            />
          }
        >
          <Icon aria-hidden className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <Link
        to="/project-home/$projectKey"
        params={{ projectKey }}
        onClick={onOpen}
        aria-label={`Open ${title} overview`}
        draggable={false}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
        activeProps={{
          "aria-current": "page",
        }}
      >
        {leading}
        <span className="min-w-0 truncate">{title}</span>
        {children}
      </Link>
    </div>
  );
}
