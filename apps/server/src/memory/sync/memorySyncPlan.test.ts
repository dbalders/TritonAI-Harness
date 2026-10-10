import { describe, expect, it } from "vite-plus/test";

import {
  alignPathCase,
  classifyVaultPath,
  conflictCopyPath,
  type CloudFile,
  type LocalFile,
  planMemorySync,
  planTeamMirror,
  type SyncAction,
  type SyncDevice,
  type SyncedFile,
} from "./memorySyncPlan.ts";

const device = { id: "5c9e6056-c9b4-4372-97c3-b5ab43adb5c7", shortId: "5c9e" };
const OWN_DAY = "Daily/2026/2026-09-29 Mac (5c9e).md";
const OTHER_DAY = "Daily/2026/2026-09-29 iMac (91c7).md";
const NOTE = "Notes/plans.md";
const WRITTEN = `.devices/${device.id}/written.json`;

const plan = (options: {
  readonly local?: Record<string, string>;
  readonly cloud?: Record<string, string>;
  readonly synced?: Record<string, [sha: string, eTag: string]>;
  readonly written?: ReadonlyArray<string>;
  readonly remoteDevices?: ReadonlyArray<SyncDevice>;
  readonly ownerId?: string | null;
}): ReadonlyArray<SyncAction> =>
  planMemorySync({
    device,
    remoteDevices: options.remoteDevices ?? [device],
    local: new Map<string, LocalFile>(
      Object.entries(options.local ?? {}).map(([path, sha256]) => [path, { sha256 }]),
    ),
    cloud: new Map<string, CloudFile>(
      Object.entries(options.cloud ?? {}).map(([path, eTag]) => [path, { eTag }]),
    ),
    synced: new Map<string, SyncedFile>(
      Object.entries(options.synced ?? {}).map(([path, [sha256, eTag]]) => [
        path,
        {
          sha256,
          eTag,
          ...(options.ownerId === null ? {} : { ownerId: options.ownerId ?? device.id }),
        },
      ]),
    ),
    written: new Set(options.written ?? []),
  });

describe("classifyVaultPath", () => {
  it("gives each computer its own files and syncs Notes both ways", () => {
    expect(classifyVaultPath(OWN_DAY, device)).toBe("own");
    expect(classifyVaultPath(OTHER_DAY, device)).toBe("other");
    expect(classifyVaultPath("Projects/Acme/Acme - Mac (5c9e).md", device)).toBe("own");
    expect(classifyVaultPath("Projects/Acme/Acme - iMac (91c7).md", device)).toBe("other");
    expect(classifyVaultPath("Inbox/5c9e/2026-09-29-1200-idea.md", device)).toBe("own");
    expect(classifyVaultPath("Inbox/91c7/processed/2026-09-29/idea.md", device)).toBe("other");
    expect(classifyVaultPath(`.devices/${device.id}/coverage.json`, device)).toBe("own");
    expect(classifyVaultPath(".devices/91c7aaaa/coverage.json", device)).toBe("other");
    expect(classifyVaultPath("Notes/Recovered/Daily/2026/x.md", device)).toBe("notes");
  });

  it("keeps local-only files out of sync", () => {
    for (const path of [
      "AGENTS.md",
      ".sync/state.json",
      "Inbox/loose.md",
      `.devices/${device.id}/.archive/2026/x.md`,
      "Notes/.obsidian/workspace.json",
      "Notes/.DS_Store",
      "Daily/2026/2026-09-29 Mac (5c9e).md.x1y2/contents.tmp",
      "stray.md",
    ]) {
      expect(classifyVaultPath(path, device)).toBe("ignored");
    }
  });
});

describe("this computer's files", () => {
  it("uploads new and changed files and leaves current ones alone", () => {
    expect(plan({ local: { [OWN_DAY]: "a" } })).toEqual([
      { kind: "upload", path: OWN_DAY, ifMatch: null },
    ]);
    expect(
      plan({
        local: { [OWN_DAY]: "b" },
        cloud: { [OWN_DAY]: "e1" },
        synced: { [OWN_DAY]: ["a", "e1"] },
      }),
    ).toEqual([{ kind: "upload", path: OWN_DAY, ifMatch: "e1" }]);
    expect(
      plan({
        local: { [OWN_DAY]: "a" },
        cloud: { [OWN_DAY]: "e1" },
        synced: { [OWN_DAY]: ["a", "e1"] },
      }),
    ).toEqual([]);
  });

  it("downloads its files into a blank or partly lost vault instead of deleting them", () => {
    // No record at all: a new install, or the vault and its sync state were lost.
    expect(plan({ cloud: { [OWN_DAY]: "e1" } })).toEqual([{ kind: "download", path: OWN_DAY }]);
    // A note Harness still lists as written went missing: restore it.
    expect(
      plan({
        local: { [WRITTEN]: "w" },
        cloud: { [OWN_DAY]: "e1", [WRITTEN]: "ew" },
        synced: { [OWN_DAY]: ["a", "e1"], [WRITTEN]: ["w", "ew"] },
        written: [OWN_DAY],
      }),
    ).toEqual([{ kind: "download", path: OWN_DAY }]);
    // The device record itself is gone, so nothing counts as removed on purpose.
    expect(plan({ cloud: { [OWN_DAY]: "e1" }, synced: { [OWN_DAY]: ["a", "e1"] } })).toEqual([
      { kind: "download", path: OWN_DAY },
    ]);
  });

  it("deletes the cloud copy only of files Harness removed on purpose", () => {
    const pending = "Inbox/5c9e/2026-09-29-1200-idea.md";
    const processed = "Inbox/5c9e/processed/2026-09-29/2026-09-29-1200-idea.md";
    expect(
      plan({
        local: { [processed]: "n", [WRITTEN]: "w" },
        cloud: { [pending]: "e1", [WRITTEN]: "ew" },
        synced: { [pending]: ["n", "e1"], [WRITTEN]: ["w", "ew"] },
      }),
    ).toEqual([
      { kind: "upload", path: processed, ifMatch: null },
      { kind: "deleteCloud", path: pending, ifMatch: "e1" },
    ]);
    // A note removed because its day no longer has anything in it.
    expect(
      plan({
        local: { [WRITTEN]: "w" },
        cloud: { [OWN_DAY]: "e1", [WRITTEN]: "ew" },
        synced: { [OWN_DAY]: ["a", "e1"], [WRITTEN]: ["w", "ew"] },
        written: [],
      }),
    ).toEqual([{ kind: "deleteCloud", path: OWN_DAY, ifMatch: "e1" }]);
    // Changed in the cloud since the last sync: keep it.
    expect(
      plan({
        local: { [WRITTEN]: "w" },
        cloud: { [pending]: "e2", [WRITTEN]: "ew" },
        synced: { [pending]: ["n", "e1"], [WRITTEN]: ["w", "ew"] },
      }),
    ).toEqual([{ kind: "download", path: pending }]);
  });

  it("restores processed inbox notes when sync metadata survives a lost inbox", () => {
    const processed = "Inbox/5c9e/processed/2026-09-29/idea.md";
    const pending = "Inbox/5c9e/idea.md";
    const other = "Inbox/91c7/processed/2026-09-29/idea.md";
    expect(
      plan({
        local: { [WRITTEN]: "w" },
        cloud: { [processed]: "ep", [pending]: "en", [other]: "eo", [WRITTEN]: "ew" },
        synced: {
          [processed]: ["processed", "ep"],
          [pending]: ["pending", "en"],
          [other]: ["other", "eo"],
          [WRITTEN]: ["w", "ew"],
        },
        written: [],
      }),
    ).toEqual([
      { kind: "download", path: pending },
      { kind: "download", path: processed },
      { kind: "download", path: other },
    ]);
  });

  it("restores a missing inbox note unless its contents survive in processed", () => {
    const pending = "Inbox/5c9e/idea.md";
    const processed = "Inbox/5c9e/processed/2026-09-30/idea-2.md";
    const baseline = {
      cloud: { [pending]: "e1" },
      synced: { [pending]: ["original", "e1"] as [string, string] },
    };
    expect(plan(baseline)).toEqual([{ kind: "download", path: pending }]);
    expect(plan({ ...baseline, local: { [processed]: "different" } })).toContainEqual({
      kind: "download",
      path: pending,
    });
    expect(plan({ ...baseline, local: { [processed]: "original" } })).toContainEqual({
      kind: "deleteCloud",
      path: pending,
      ifMatch: "e1",
    });
  });

  it("keeps a cloud copy someone else changed and stops if its device record was taken over", () => {
    expect(
      plan({
        local: { [OWN_DAY]: "a" },
        cloud: { [OWN_DAY]: "e2" },
        synced: { [OWN_DAY]: ["a", "e1"] },
      }),
    ).toEqual([{ kind: "archiveThenUpload", path: OWN_DAY, ifMatch: "e2" }]);
    const record = `.devices/${device.id}/device.json`;
    expect(
      plan({
        local: { [record]: "a" },
        cloud: { [record]: "e2" },
        synced: { [record]: ["a", "e1"] },
      }),
    ).toEqual([{ kind: "ownerConflict", path: record }]);
    expect(plan({ local: { [OWN_DAY]: "a" }, cloud: { [OWN_DAY]: "e1" } })).toEqual([
      { kind: "compare", path: OWN_DAY, pathClass: "own" },
    ]);
  });
});

describe("other computers' files", () => {
  it("downloads new and changed files, restores local edits, and follows deletes", () => {
    expect(plan({ cloud: { [OTHER_DAY]: "e1" } })).toEqual([{ kind: "download", path: OTHER_DAY }]);
    expect(
      plan({
        local: { [OTHER_DAY]: "a" },
        cloud: { [OTHER_DAY]: "e2" },
        synced: { [OTHER_DAY]: ["a", "e1"] },
      }),
    ).toEqual([{ kind: "download", path: OTHER_DAY }]);
    expect(
      plan({
        local: { [OTHER_DAY]: "x" },
        cloud: { [OTHER_DAY]: "e1" },
        synced: { [OTHER_DAY]: ["a", "e1"] },
      }),
    ).toEqual([{ kind: "download", path: OTHER_DAY }]);
    expect(
      plan({
        local: { [OTHER_DAY]: "a" },
        cloud: { [OTHER_DAY]: "e1" },
        synced: { [OTHER_DAY]: ["a", "e1"] },
      }),
    ).toEqual([]);
    expect(plan({ local: { [OTHER_DAY]: "a" }, synced: { [OTHER_DAY]: ["a", "e1"] } })).toEqual([
      { kind: "deleteLocal", path: OTHER_DAY },
    ]);
    // Never uploads another computer's file, and leaves one sync never saw.
    expect(plan({ local: { [OTHER_DAY]: "a" } })).toEqual([]);
  });
});

describe("Notes", () => {
  it("syncs edits both ways and keeps both copies when both sides changed", () => {
    const synced = { [NOTE]: ["a", "e1"] as [string, string] };
    expect(plan({ local: { [NOTE]: "b" }, cloud: { [NOTE]: "e1" }, synced })).toEqual([
      { kind: "upload", path: NOTE, ifMatch: "e1" },
    ]);
    expect(plan({ local: { [NOTE]: "a" }, cloud: { [NOTE]: "e2" }, synced })).toEqual([
      { kind: "download", path: NOTE },
    ]);
    expect(plan({ local: { [NOTE]: "b" }, cloud: { [NOTE]: "e2" }, synced })).toEqual([
      { kind: "conflictCopy", path: NOTE },
    ]);
    expect(plan({ local: { [NOTE]: "b" }, cloud: { [NOTE]: "e1" } })).toEqual([
      { kind: "compare", path: NOTE, pathClass: "notes" },
    ]);
  });

  it("follows deletes only when the other side is unchanged", () => {
    const synced = { [NOTE]: ["a", "e1"] as [string, string] };
    expect(plan({ cloud: { [NOTE]: "e1" }, synced })).toEqual([
      { kind: "deleteCloud", path: NOTE, ifMatch: "e1" },
    ]);
    expect(plan({ cloud: { [NOTE]: "e2" }, synced })).toEqual([{ kind: "download", path: NOTE }]);
    expect(plan({ local: { [NOTE]: "a" }, synced })).toEqual([{ kind: "deleteLocal", path: NOTE }]);
    expect(plan({ local: { [NOTE]: "b" }, synced })).toEqual([
      { kind: "upload", path: NOTE, ifMatch: null },
    ]);
  });
});

describe("conflictCopyPath", () => {
  it("keeps the folder and extension", () => {
    expect(conflictCopyPath("Notes/Projects/plans.md", "Mac (5c9e)", "2026-09-29 221530")).toBe(
      "Notes/Projects/plans (conflict Mac (5c9e) 2026-09-29 221530).md",
    );
  });
});

describe("alignPathCase", () => {
  it("treats a case-only rename in OneDrive as the same file, never a delete", () => {
    const aligned = alignPathCase({
      local: new Map([["Notes/plans.md", { sha256: "a" }]]),
      cloud: new Map([["Notes/Plans.md", { eTag: "e2" }]]),
      synced: new Map([["Notes/plans.md", { sha256: "a", eTag: "e1" }]]),
    });
    expect([...aligned.local.keys()]).toEqual(["Notes/Plans.md"]);
    expect([...aligned.synced.keys()]).toEqual(["Notes/Plans.md"]);
    expect(aligned.diskPath.get("Notes/Plans.md")).toBe("Notes/plans.md");
    const actions = planMemorySync({
      device,
      local: aligned.local,
      cloud: new Map([["Notes/Plans.md", { eTag: "e2" }]]),
      synced: aligned.synced,
      written: new Set(),
    });
    expect(actions).toEqual([{ kind: "download", path: "Notes/Plans.md" }]);
  });

  it("keeps only one of two local files that differ only in case", () => {
    const aligned = alignPathCase({
      local: new Map([
        ["Notes/a.md", { sha256: "1" }],
        ["Notes/A.md", { sha256: "2" }],
      ]),
      cloud: new Map<string, { eTag: string }>(),
      synced: new Map<string, { sha256: string; eTag: string }>(),
    });
    expect(aligned.local.size).toBe(1);
  });
});

describe("generated note ownership", () => {
  it("preserves a downloaded note after local loss when only its short ID matches", () => {
    const path = "Daily/2026-10-02 Other computer (aaaa).md";
    const actions = planMemorySync({
      device: { id: "aaaaaaaa-new", shortId: "aaaa" },
      local: new Map([[".devices/aaaaaaaa-new/written.json", { sha256: "manifest" }]]),
      cloud: new Map([[path, { eTag: "unchanged" }]]),
      synced: new Map([[path, { sha256: "note", eTag: "unchanged" }]]),
      written: new Set(),
    });
    expect(actions).toContainEqual({ kind: "download", path });
    expect(actions.some((action) => action.kind === "deleteCloud")).toBe(false);
  });
});

describe("full-ID provenance", () => {
  it.each(["Daily/2026/Mac (5c9e).md", "Projects/X/X - Mac (5c9e).md"])(
    "requires both upload provenance and a remote owner record to delete %s",
    (path) => {
      const input = {
        local: { [WRITTEN]: "w" },
        cloud: { [path]: "e1", [WRITTEN]: "ew" },
        synced: {
          [path]: ["note", "e1"] as [string, string],
          [WRITTEN]: ["w", "ew"] as [string, string],
        },
      };
      expect(plan(input)).toContainEqual({ kind: "deleteCloud", path, ifMatch: "e1" });
      for (const overrides of [
        { remoteDevices: [] },
        { ownerId: null },
        { ownerId: "other-full-id" },
      ]) {
        expect(plan({ ...input, ...overrides })).toContainEqual({ kind: "download", path });
        expect(
          plan({ ...input, ...overrides }).some((action) => action.kind === "deleteCloud"),
        ).toBe(false);
      }
    },
  );

  it("stops every action when independent full IDs share a code", () => {
    const actions = plan({
      remoteDevices: [device, { id: "other-full-id", shortId: device.shortId }],
      local: { [WRITTEN]: "w", [NOTE]: "new" },
      cloud: { [OWN_DAY]: "e1" },
      synced: { [OWN_DAY]: ["note", "e1"] },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "ownerConflict" });
  });
});

describe("team copies", () => {
  const TEAM_NOTE = "teams/grant-reports-3f2a1c/Memory/author/device/record.md";
  const mirror = (options: {
    readonly local?: Record<string, string>;
    readonly cloud?: Record<string, string>;
    readonly synced?: Record<string, [sha: string, eTag: string]>;
  }) =>
    planTeamMirror({
      local: new Map(
        Object.entries(options.local ?? {}).map(([path, sha256]) => [path, { sha256 }]),
      ),
      cloud: new Map(Object.entries(options.cloud ?? {}).map(([path, eTag]) => [path, { eTag }])),
      synced: new Map(
        Object.entries(options.synced ?? {}).map(([path, [sha256, eTag]]) => [
          path,
          { sha256, eTag },
        ]),
      ),
    });

  it("classifies the teams folder apart from every computer's files", () => {
    expect(classifyVaultPath(TEAM_NOTE, device)).toBe("team");
    expect(classifyVaultPath("teams/README.md", device)).toBe("ignored");
    expect(classifyVaultPath("teams/grant-reports-3f2a1c/.obsidian/app.json", device)).toBe(
      "ignored",
    );
  });

  it("never sends a team copy to OneDrive or takes one from it", () => {
    expect(plan({ local: { [TEAM_NOTE]: "a" } })).toEqual([]);
    expect(plan({ cloud: { [TEAM_NOTE]: "e1" } })).toEqual([]);
    expect(plan({ local: { [TEAM_NOTE]: "a" }, synced: { [TEAM_NOTE]: ["a", "e1"] } })).toEqual([]);
  });

  it("downloads new and changed team documents and replaces local edits", () => {
    expect(mirror({ cloud: { [TEAM_NOTE]: "e1" } })).toEqual([
      { kind: "download", path: TEAM_NOTE },
    ]);
    expect(
      mirror({
        local: { [TEAM_NOTE]: "a" },
        cloud: { [TEAM_NOTE]: "e2" },
        synced: { [TEAM_NOTE]: ["a", "e1"] },
      }),
    ).toEqual([{ kind: "download", path: TEAM_NOTE }]);
    // The copy is read-only: an edit here is replaced, never uploaded.
    expect(
      mirror({
        local: { [TEAM_NOTE]: "edited" },
        cloud: { [TEAM_NOTE]: "e1" },
        synced: { [TEAM_NOTE]: ["a", "e1"] },
      }),
    ).toEqual([{ kind: "download", path: TEAM_NOTE }]);
    expect(
      mirror({
        local: { [TEAM_NOTE]: "a" },
        cloud: { [TEAM_NOTE]: "e1" },
        synced: { [TEAM_NOTE]: ["a", "e1"] },
      }),
    ).toEqual([]);
  });

  it("removes a document the team removed, and only what it copied", () => {
    expect(mirror({ local: { [TEAM_NOTE]: "a" }, synced: { [TEAM_NOTE]: ["a", "e1"] } })).toEqual([
      { kind: "deleteLocal", path: TEAM_NOTE },
    ]);
    expect(mirror({ local: { [TEAM_NOTE]: "a" } })).toEqual([]);
    expect(mirror({ synced: { [TEAM_NOTE]: ["a", "e1"] } })).toEqual([
      { kind: "forget", path: TEAM_NOTE },
    ]);
  });

  it("plans only paths inside the teams folder", () => {
    expect(mirror({ cloud: { [NOTE]: "e1", [OTHER_DAY]: "e2" } })).toEqual([]);
  });
});
