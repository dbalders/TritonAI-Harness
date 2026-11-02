import { describe, expect, it } from "vite-plus/test";

import { resolveProjectExpanded } from "../../uiStateStore";
import { sidebarFolderExpansionKeys } from "../Sidebar.logic";
import {
  HARNESS_COLLAPSED_FOLDERS_KEY,
  migrateHarnessCollapsedFolders,
} from "./harnessFolderStateMigration";

function memoryStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
    has: (key: string) => values.has(key),
  };
}

const alpha = {
  projectKey: "alpha",
  memberProjects: [{ physicalProjectKey: "local:/code/alpha", workspaceRoot: "/code/alpha" }],
};
const beta = {
  projectKey: "beta",
  memberProjects: [{ physicalProjectKey: "local:/code/beta", workspaceRoot: "/code/beta" }],
};

describe("migrateHarnessCollapsedFolders", () => {
  it("keeps closed folders closed, overrides older saved state, and drops the old key", () => {
    // An older per-project sidebar once closed beta under its cwd key.
    const expanded: Record<string, boolean> = {
      [sidebarFolderExpansionKeys(beta).at(-1)!]: false,
    };
    const storage = memoryStorage({ [HARNESS_COLLAPSED_FOLDERS_KEY]: JSON.stringify(["alpha"]) });

    migrateHarnessCollapsedFolders(
      [alpha, beta],
      (keys, value) => {
        for (const key of keys) expanded[key] = value;
      },
      storage,
    );

    expect(resolveProjectExpanded(expanded, sidebarFolderExpansionKeys(alpha))).toBe(false);
    // Beta was open in the Harness sidebar, so it stays open.
    expect(resolveProjectExpanded(expanded, sidebarFolderExpansionKeys(beta))).toBe(true);
    expect(storage.has(HARNESS_COLLAPSED_FOLDERS_KEY)).toBe(false);
  });

  it("changes nothing when there is no saved Harness state", () => {
    const writes: unknown[] = [];
    migrateHarnessCollapsedFolders([alpha], (...args) => writes.push(args), memoryStorage({}));
    expect(writes).toEqual([]);
  });

  it("drops a corrupt value without closing any folder", () => {
    const writes: Array<[readonly string[], boolean]> = [];
    const storage = memoryStorage({ [HARNESS_COLLAPSED_FOLDERS_KEY]: "{not json" });
    migrateHarnessCollapsedFolders([alpha], (keys, value) => writes.push([keys, value]), storage);
    expect(writes.every(([, value]) => value)).toBe(true);
    expect(storage.has(HARNESS_COLLAPSED_FOLDERS_KEY)).toBe(false);
  });
});
