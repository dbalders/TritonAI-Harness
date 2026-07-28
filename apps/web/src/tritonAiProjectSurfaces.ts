import type { ScopedProjectRef } from "@t3tools/contracts";
import type { SidebarProjectSortOrder } from "@t3tools/contracts/settings";

import { sortScopedProjectsForSidebar } from "./components/Sidebar.logic";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";
import { partitionTritonAiChatsProjects } from "./tritonAiWorkspace";
import type { Project, ThreadShell } from "./types";

type SidebarProjectSnapshotsInput = Parameters<typeof buildSidebarProjectSnapshots>[0];
type ProjectThreadContext = Pick<ScopedProjectRef, "environmentId" | "projectId">;

export type GenericNewThreadShortcutAction = "none" | "start" | "choose";

/**
 * The dedicated Chats workspace has its own navigation and creation semantics.
 * Generic project surfaces must only operate on ordinary user projects.
 */
export function buildRegularSidebarProjectSnapshots(
  input: SidebarProjectSnapshotsInput,
): SidebarProjectSnapshot[] {
  const { regularProjects } = partitionTritonAiChatsProjects(input.projects);
  return buildSidebarProjectSnapshots({ ...input, projects: regularProjects });
}

export function sortRegularScopedProjectsForSidebar(
  projects: readonly Project[],
  threads: readonly ThreadShell[],
  sortOrder: SidebarProjectSortOrder,
): Project[] {
  const { regularProjects } = partitionTritonAiChatsProjects(projects);
  return sortScopedProjectsForSidebar(regularProjects, threads, sortOrder);
}

export function isRegularProjectThreadContext(
  projects: readonly Project[],
  context: ProjectThreadContext | null | undefined,
): boolean {
  if (!context) {
    return false;
  }
  const { regularProjects } = partitionTritonAiChatsProjects(projects);
  return regularProjects.some(
    (project) =>
      project.environmentId === context.environmentId && project.id === context.projectId,
  );
}

export function resolveGenericNewThreadShortcutAction(input: {
  readonly command: "chat.new" | "chat.newLocal";
  readonly projectGroupCount: number;
  readonly sidebarV2Enabled: boolean;
}): GenericNewThreadShortcutAction {
  if (input.projectGroupCount <= 0) {
    return "none";
  }
  if (input.command === "chat.new" && input.sidebarV2Enabled && input.projectGroupCount > 1) {
    return "choose";
  }
  return "start";
}
