import type {
  ServerManagedSkillsStatus,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSkillCatalogEntry,
} from "@t3tools/contracts";

export function isProviderSkillMutationBlocked(status: ServerManagedSkillsStatus): boolean {
  return status === "invalid" || status === "unknown";
}

export function isProviderSkillPublishable(skill: ServerProviderSkill): boolean {
  const normalizedPath = skill.path.replaceAll("\\", "/");
  const normalizedScope = skill.scope?.trim().toLowerCase();
  return (
    normalizedScope !== "system" &&
    !normalizedPath.includes("/.codex/plugins/") &&
    !normalizedPath.includes("/.agents/plugins/") &&
    normalizedPath.endsWith("/SKILL.md")
  );
}

export interface ProviderSkillRow {
  readonly provider: ServerProvider;
  readonly skill: ServerProviderSkill;
}

export interface ProviderCatalogSkillItem {
  readonly entry: ServerProviderSkillCatalogEntry;
  readonly installedRow: ProviderSkillRow | null;
  readonly managed: boolean;
}

export function dedupeProviderSkillRows(
  rows: ReadonlyArray<ProviderSkillRow>,
): ReadonlyArray<ProviderSkillRow> {
  const rowByPath = new Map<string, ProviderSkillRow>();
  for (const row of rows) {
    const existing = rowByPath.get(row.skill.path);
    if (!existing || (!existing.skill.enabled && row.skill.enabled)) {
      rowByPath.set(row.skill.path, row);
    }
  }
  return [...rowByPath.values()];
}

export function groupProviderSkills(input: {
  readonly entries: ReadonlyArray<ServerProviderSkillCatalogEntry>;
  readonly rows: ReadonlyArray<ProviderSkillRow>;
  readonly managedSkillNames: ReadonlySet<string>;
}) {
  const rows = dedupeProviderSkillRows(input.rows);
  const installedByName = new Map<string, ProviderSkillRow>();
  for (const row of rows) {
    if (!installedByName.has(row.skill.name)) {
      installedByName.set(row.skill.name, row);
    }
  }

  const matchedRows = new Set<ProviderSkillRow>();
  const toItem = (entry: ServerProviderSkillCatalogEntry): ProviderCatalogSkillItem => {
    const installedRow = installedByName.get(entry.name) ?? null;
    if (installedRow) matchedRows.add(installedRow);
    return {
      entry,
      installedRow,
      managed: input.managedSkillNames.has(entry.name),
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
  return {
    aiTeamItems,
    communityItems,
    managedOnlyRows: rows.filter(
      (row) => input.managedSkillNames.has(row.skill.name) && !matchedRows.has(row),
    ),
    otherRows: rows.filter(
      (row) => !matchedRows.has(row) && !input.managedSkillNames.has(row.skill.name),
    ),
  };
}
