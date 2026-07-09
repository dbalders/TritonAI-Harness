import type {
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSkillCatalogEntry,
} from "@t3tools/contracts";

export interface ProviderSkillRow {
  readonly provider: ServerProvider;
  readonly skill: ServerProviderSkill;
}

export interface ProviderCatalogSkillItem {
  readonly entry: ServerProviderSkillCatalogEntry;
  readonly installedRow: ProviderSkillRow | null;
  readonly managed: boolean;
}

export function groupProviderSkills(input: {
  readonly entries: ReadonlyArray<ServerProviderSkillCatalogEntry>;
  readonly rows: ReadonlyArray<ProviderSkillRow>;
  readonly managedSkillNames: ReadonlySet<string>;
}) {
  const installedByName = new Map<string, ProviderSkillRow>();
  for (const row of input.rows) {
    if (!installedByName.has(row.skill.name)) {
      installedByName.set(row.skill.name, row);
    }
  }

  const toItem = (entry: ServerProviderSkillCatalogEntry): ProviderCatalogSkillItem => {
    const installedRow = installedByName.get(entry.name) ?? null;
    return {
      entry,
      installedRow,
      managed: installedRow !== null && input.managedSkillNames.has(installedRow.skill.name),
    };
  };
  const byTitle = (left: ProviderCatalogSkillItem, right: ProviderCatalogSkillItem) =>
    left.entry.title.localeCompare(right.entry.title);

  const aiTeamItems = input.entries
    .filter((entry) => entry.section === "ai-team")
    .map(toItem)
    .toSorted(byTitle);
  const communityItems = input.entries
    .filter((entry) => entry.section === "community" && !input.managedSkillNames.has(entry.name))
    .map(toItem)
    .toSorted(byTitle);
  const aiTeamCatalogNames = new Set(aiTeamItems.map((item) => item.entry.name));
  const matchedNames = new Set([
    ...aiTeamCatalogNames,
    ...communityItems.map((item) => item.entry.name),
    ...input.managedSkillNames,
  ]);

  return {
    aiTeamItems,
    communityItems,
    managedOnlyRows: input.rows.filter(
      (row) =>
        input.managedSkillNames.has(row.skill.name) && !aiTeamCatalogNames.has(row.skill.name),
    ),
    otherRows: input.rows.filter((row) => !matchedNames.has(row.skill.name)),
  };
}
