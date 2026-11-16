import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { useSortable } from "@dnd-kit/sortable";
import { Link } from "@tanstack/react-router";
import { FolderIcon, FolderOpenIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** The parts of a sortable folder that let its header lift the folder. */
export type SidebarProjectFolderDragHandle = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setActivatorNodeRef"
>;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder header. A closed folder shows its count and a status dot.
 * Harness: the folder icon opens or closes it, the name opens the project
 * overview, New thread stays visible, and the header drags the folder. The
 * folder icon is the keyboard tree row; the name and New thread are its controls.
 */
export function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  dragHandle: SidebarProjectFolderDragHandle | null;
  canReorder: boolean;
  // Same-named folders on two machines differ only by where they live.
  badge?: ReactNode;
  onToggle: (group: SidebarProjectSnapshot) => void;
  onOpen: () => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const { group, collapsed, hiddenThreads, dragHandle } = props;
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  const toggleLabel = `${collapsed ? "Expand" : "Collapse"} ${group.displayName} threads`;
  const draggable = dragHandle !== null && props.canReorder;
  const ToggleIcon = collapsed ? FolderIcon : FolderOpenIcon;
  return (
    <div
      ref={dragHandle?.setActivatorNodeRef}
      {...(dragHandle !== null && props.canReorder ? dragHandle.listeners : {})}
      data-testid="sidebar-project-folder"
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(group, { x: event.clientX, y: event.clientY });
      }}
      className={cn(
        "group/project-folder flex h-8 min-w-0 items-center gap-0.5 rounded-(--control-radius) pr-1 pl-1 hover:bg-sidebar-row-hover pointer-coarse:h-11",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              role="treeitem"
              tabIndex={-1}
              data-sidebar-row={rowId}
              aria-expanded={!collapsed}
              aria-label={group.displayName}
              onClick={() => props.onToggle(group)}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-sm text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:size-11",
                draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
              )}
            />
          }
        >
          <ToggleIcon aria-hidden className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
      </Tooltip>
      <Link
        to="/project-home/$projectKey"
        params={{ projectKey: group.projectKey }}
        onClick={props.onOpen}
        data-sidebar-action-for={rowId}
        aria-label={`Open ${group.displayName} overview`}
        draggable={false}
        className={cn(
          "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-(--control-radius) pl-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        activeProps={{ "aria-current": "page" }}
      >
        <span className="min-w-0 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {props.badge}
      </Link>
      {dot ? (
        <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
          <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
        </span>
      ) : null}
      {collapsed && hiddenThreads.length > 0 ? (
        <span className="shrink-0 px-1 text-xs tabular-nums text-sidebar-muted-foreground">
          <span aria-hidden>{hiddenThreads.length}</span>
          <span className="sr-only">{`${hiddenThreads.length} hidden ${
            hiddenThreads.length === 1 ? "thread" : "threads"
          }`}</span>
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              data-sidebar-action-for={rowId}
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`New thread in ${group.displayName}`}
              onClick={() => props.onNewThread(group)}
            />
          }
        >
          <PlusIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="top">New thread in {group.displayName}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
