import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSkillCatalogEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  groupProviderSkills,
  isProviderSkillMutationBlocked,
  isProviderSkillPublishable,
  type ProviderSkillRow,
} from "./providerSkillGrouping";

const provider = {
  instanceId: "codex" as ProviderInstanceId,
  driver: "codex",
} as ServerProvider;

function row(name: string): ProviderSkillRow {
  return {
    provider,
    skill: { name, path: `/tmp/skills/${name}/SKILL.md`, enabled: true },
  };
}

function entry(
  name: string,
  section: ServerProviderSkillCatalogEntry["section"],
): ServerProviderSkillCatalogEntry {
  return {
    id: `${section === "ai-team" ? "tritonai" : "community"}/${name}`,
    name,
    title: name,
    description: `${name} description`,
    section,
    revision: "a".repeat(40),
    sourceUrl: `https://github.com/dbalders/UCSD-Skills-Library/tree/${"a".repeat(40)}/${name}`,
  };
}

describe("groupProviderSkills", () => {
  it("does not offer a conflicting community entry over a managed skill", () => {
    const result = groupProviderSkills({
      entries: [entry("secure-review", "community")],
      rows: [row("secure-review")],
      managedSkillNames: new Set(["secure-review"]),
    });

    expect(result.communityItems).toEqual([]);
    expect(result.managedOnlyRows).toHaveLength(1);
  });

  it("keeps a manifest-owned catalog skill managed when its folder is missing", () => {
    const result = groupProviderSkills({
      entries: [entry("secure-review", "ai-team")],
      rows: [],
      managedSkillNames: new Set(["secure-review"]),
    });

    expect(result.aiTeamItems).toEqual([
      expect.objectContaining({ installedRow: null, managed: true }),
    ]);
  });

  it("blocks installation and removal while managed ownership is invalid or unknown", () => {
    expect(isProviderSkillMutationBlocked("invalid")).toBe(true);
    expect(isProviderSkillMutationBlocked("unknown")).toBe(true);
    expect(isProviderSkillMutationBlocked("absent")).toBe(false);
    expect(isProviderSkillMutationBlocked("valid")).toBe(false);
  });

  it("offers Commons submission only for local SKILL.md-backed skills", () => {
    expect(isProviderSkillPublishable(row("my-local-skill").skill)).toBe(true);
    expect(
      isProviderSkillPublishable({
        ...row("system-skill").skill,
        scope: "system",
      }),
    ).toBe(false);
    expect(
      isProviderSkillPublishable({
        ...row("plugin-skill").skill,
        path: "/tmp/.codex/plugins/example/skills/plugin-skill/SKILL.md",
      }),
    ).toBe(false);
  });
});
