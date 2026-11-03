import { sidebarFolderExpansionKeys } from "../Sidebar.logic";

/** Where the Harness folder sidebar saved the project keys of closed folders. */
export const HARNESS_COLLAPSED_FOLDERS_KEY = "t3code:sidebar-v2:collapsed-projects";

type FolderGroup = Parameters<typeof sidebarFolderExpansionKeys>[0];

/**
 * Moves the Harness folder sidebar's closed folders into the shared folder state
 * that the upstream project folders read, then drops the old key. Every listed
 * group is written, so an older saved state cannot reopen or close a folder the
 * user last saw the other way.
 */
export function migrateHarnessCollapsedFolders(
  groups: readonly FolderGroup[],
  setProjectExpanded: (keys: readonly string[], expanded: boolean) => void,
  storage: Pick<Storage, "getItem" | "removeItem"> | undefined = globalThis.localStorage,
): void {
  if (storage === undefined) return;
  let raw: string | null;
  try {
    raw = storage.getItem(HARNESS_COLLAPSED_FOLDERS_KEY);
  } catch {
    return;
  }
  if (raw === null) return;
  const collapsed = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const key of parsed) if (typeof key === "string") collapsed.add(key);
    }
  } catch {
    // A corrupt value carries nothing over; it is still removed below.
  }
  for (const group of groups) {
    setProjectExpanded(sidebarFolderExpansionKeys(group), !collapsed.has(group.projectKey));
  }
  try {
    storage.removeItem(HARNESS_COLLAPSED_FOLDERS_KEY);
  } catch {
    // Storage errors leave the key for the next load.
  }
}
