import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSkillCatalogEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupProviderSkills,
  isProviderSkillRemovalBlocked,
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
  it("keeps secure managed skills in AI Team and arbitrary local skills in Other", () => {
    const managed = row("secure-review");
    const publicInstalled = row("tritonai-feedback");
    const local = row("my-local-skill");
    const result = groupProviderSkills({
      entries: [entry("tritonai-feedback", "ai-team")],
      rows: [managed, publicInstalled, local],
      managedSkillNames: new Set(["secure-review"]),
    });

    expect(result.aiTeamItems[0]?.installedRow).toBe(publicInstalled);
    expect(result.managedOnlyRows).toEqual([managed]);
    expect(result.otherRows).toEqual([local]);
  });

  it("does not offer a conflicting community entry over a managed skill", () => {
    const result = groupProviderSkills({
      entries: [entry("secure-review", "community")],
      rows: [row("secure-review")],
      managedSkillNames: new Set(["secure-review"]),
    });

    expect(result.communityItems).toEqual([]);
    expect(result.managedOnlyRows).toHaveLength(1);
  });

  it("blocks removal while managed ownership is invalid or unknown", () => {
    expect(isProviderSkillRemovalBlocked("invalid")).toBe(true);
    expect(isProviderSkillRemovalBlocked("unknown")).toBe(true);
    expect(isProviderSkillRemovalBlocked("absent")).toBe(false);
    expect(isProviderSkillRemovalBlocked("valid")).toBe(false);
  });
});
