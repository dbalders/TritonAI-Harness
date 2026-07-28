import type { SidebarProjectSortOrder } from "@t3tools/contracts/settings";

import { sortScopedProjectsForSidebar } from "./components/Sidebar.logic";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";
import { partitionTritonAiChatsProjects } from "./tritonAiWorkspace";
import type { Project, ThreadShell } from "./types";

type SidebarProjectSnapshotsInput = Parameters<typeof buildSidebarProjectSnapshots>[0];

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
