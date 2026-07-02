import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSkillCatalog,
  ServerProviderSkillCatalogEntry,
} from "@t3tools/contracts";
import {
  BookOpenIcon,
  CloudIcon,
  ExternalLinkIcon,
  LinkIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
} from "../../providerSkillPresentation";
import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface CodexSkillRow {
  readonly provider: ServerProvider;
  readonly skill: ServerProviderSkill;
}

interface CatalogSkillItem {
  readonly entry: ServerProviderSkillCatalogEntry;
  readonly installedRow: CodexSkillRow | null;
}

function unwrapAtomCommandResult<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }
  return result.value;
}

function isCodexProvider(provider: ServerProvider): boolean {
  return provider.driver === "codex";
}

function providerLabel(provider: Pick<ServerProvider, "displayName" | "instanceId">): string {
  return provider.displayName ?? provider.instanceId;
}

function skillStatusLabel(row: CodexSkillRow): "Disabled" | "Enabled" {
  return row.skill.enabled ? "Enabled" : "Disabled";
}

function skillStatusVariant(status: ReturnType<typeof skillStatusLabel>) {
  return status === "Enabled" ? "success" : "warning";
}

function skillRowKey(row: CodexSkillRow): string {
  return `${row.provider.instanceId}:${row.skill.path || row.skill.name}`;
}

function formatCatalogTierLabel(tier: ServerProviderSkillCatalogEntry["tier"]): string {
  switch (tier) {
    case "core":
      return "Core";
    case "verified":
      return "Verified";
    case "experimental":
      return "Experimental";
  }
}

function buildCatalogItems(
  entries: ReadonlyArray<ServerProviderSkillCatalogEntry>,
  rows: ReadonlyArray<CodexSkillRow>,
  section: ServerProviderSkillCatalogEntry["section"],
): ReadonlyArray<CatalogSkillItem> {
  const installedByName = new Map<string, CodexSkillRow>();
  for (const row of rows) {
    if (!installedByName.has(row.skill.name)) {
      installedByName.set(row.skill.name, row);
    }
  }

  return entries
    .filter((entry) => entry.section === section)
    .map((entry) => ({
      entry,
      installedRow: installedByName.get(entry.name) ?? null,
    }))
    .toSorted((left, right) => left.entry.title.localeCompare(right.entry.title));
}

function SkillSettingsRow({
  row,
  updating,
  removing,
  onSetEnabled,
  onRemove,
}: {
  readonly row: CodexSkillRow;
  readonly updating: boolean;
  readonly removing: boolean;
  readonly onSetEnabled: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
    enabled: boolean,
  ) => Promise<void>;
  readonly onRemove: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
  ) => Promise<void>;
}) {
  const displayName = formatProviderSkillDisplayName(row.skill);
  const status = skillStatusLabel(row);
  const sourceLabel = formatProviderSkillInstallSource(row.skill);
  const details = [
    providerLabel(row.provider),
    sourceLabel,
    row.skill.scope ? `${row.skill.scope} scope` : null,
  ].filter(Boolean);

  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{displayName}</span>
          <Badge size="sm" variant={skillStatusVariant(status)}>
            {status}
          </Badge>
        </span>
      }
      description={
        row.skill.shortDescription ?? row.skill.description ?? "No skill description provided."
      }
      status={
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate">{details.join(" / ")}</span>
          <code className="block truncate font-mono text-[10px] text-muted-foreground/70">
            {row.skill.path}
          </code>
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={row.skill.enabled}
            aria-label={`${displayName} skill enabled`}
            disabled={updating || removing}
            onCheckedChange={(checked) =>
              void onSetEnabled(row.provider.instanceId, row.skill, Boolean(checked))
            }
          />
          <Button
            size="icon-xs"
            variant="outline"
            className="text-muted-foreground"
            disabled={updating || removing}
            aria-label={`Remove ${displayName}`}
            onClick={() => void onRemove(row.provider.instanceId, row.skill)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      }
    />
  );
}

function CatalogSkillSettingsRow({
  item,
  installDisabled,
  installing,
  updating,
  removing,
  onInstall,
  onSetEnabled,
  onRemove,
}: {
  readonly item: CatalogSkillItem;
  readonly installDisabled: boolean;
  readonly installing: boolean;
  readonly updating: boolean;
  readonly removing: boolean;
  readonly onInstall: (entry: ServerProviderSkillCatalogEntry) => Promise<void>;
  readonly onSetEnabled: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
    enabled: boolean,
  ) => Promise<void>;
  readonly onRemove: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
  ) => Promise<void>;
}) {
  const row = item.installedRow;
  const details = [
    item.entry.category,
    formatCatalogTierLabel(item.entry.tier),
    item.entry.owner,
  ].filter(Boolean);

  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{item.entry.title}</span>
          {row ? (
            <Badge size="sm" variant={skillStatusVariant(skillStatusLabel(row))}>
              {skillStatusLabel(row)}
            </Badge>
          ) : (
            <Badge size="sm" variant="outline">
              Available
            </Badge>
          )}
        </span>
      }
      description={item.entry.description}
      status={
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate">{details.join(" / ")}</span>
          {row ? (
            <code className="block truncate font-mono text-[10px] text-muted-foreground/70">
              {row.skill.path}
            </code>
          ) : item.entry.readmeUrl ? (
            <button
              type="button"
              className="inline-flex w-fit items-center gap-1 text-[11px] text-primary hover:underline"
              onClick={() => void ensureLocalApi().shell.openExternal(item.entry.readmeUrl!)}
            >
              Source <ExternalLinkIcon className="size-3" />
            </button>
          ) : null}
        </div>
      }
      control={
        row ? (
          <div className="flex items-center gap-2">
            <Switch
              checked={row.skill.enabled}
              aria-label={`${item.entry.title} skill enabled`}
              disabled={updating || removing}
              onCheckedChange={(checked) =>
                void onSetEnabled(row.provider.instanceId, row.skill, Boolean(checked))
              }
            />
            <Button
              size="icon-xs"
              variant="outline"
              className="text-muted-foreground"
              disabled={updating || removing}
              aria-label={`Remove ${item.entry.title}`}
              onClick={() => void onRemove(row.provider.instanceId, row.skill)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={installDisabled || installing}
            onClick={() => void onInstall(item.entry)}
          >
            <PlusIcon className="size-3.5" />
            {installing ? "Adding..." : "Add"}
          </Button>
        )
      }
    />
  );
}

function CatalogSkillSection({
  title,
  icon,
  items,
  emptyTitle,
  emptyDescription,
  installDisabled,
  installingSkillKey,
  updatingSkillKey,
  removingSkillKey,
  onInstall,
  onSetEnabled,
  onRemove,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly items: ReadonlyArray<CatalogSkillItem>;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly installDisabled: boolean;
  readonly installingSkillKey: string | null;
  readonly updatingSkillKey: string | null;
  readonly removingSkillKey: string | null;
  readonly onInstall: (entry: ServerProviderSkillCatalogEntry) => Promise<void>;
  readonly onSetEnabled: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
    enabled: boolean,
  ) => Promise<void>;
  readonly onRemove: (
    providerInstanceId: ProviderInstanceId,
    skill: ServerProviderSkill,
  ) => Promise<void>;
}) {
  const installedCount = items.filter((item) => item.installedRow).length;

  return (
    <SettingsSection
      title={title}
      icon={icon}
      headerAction={
        <span className="text-[11px] text-muted-foreground">
          {installedCount}/{items.length} installed
        </span>
      }
    >
      {items.length === 0 ? (
        <div className="p-8">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CloudIcon />
              </EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
              <EmptyDescription>{emptyDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        items.map((item) => {
          const installedKey = item.installedRow ? skillRowKey(item.installedRow) : null;
          return (
            <CatalogSkillSettingsRow
              key={item.entry.id}
              item={item}
              installDisabled={installDisabled}
              installing={installingSkillKey === `catalog:${item.entry.id}`}
              updating={installedKey !== null && updatingSkillKey === installedKey}
              removing={installedKey !== null && removingSkillKey === installedKey}
              onInstall={onInstall}
              onSetEnabled={onSetEnabled}
              onRemove={onRemove}
            />
          );
        })
      )}
    </SettingsSection>
  );
}

export function SkillsSettingsPanel() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const listCatalogCommand = useAtomCommand(serverEnvironment.listProviderSkillCatalog, {
    label: "skill catalog list",
    reportFailure: false,
  });
  const installSkillCommand = useAtomCommand(serverEnvironment.installProviderSkill, {
    label: "skill install",
    reportFailure: false,
  });
  const removeSkillCommand = useAtomCommand(serverEnvironment.removeProviderSkill, {
    label: "skill remove",
    reportFailure: false,
  });
  const setSkillEnabledCommand = useAtomCommand(serverEnvironment.setProviderSkillEnabled, {
    label: "skill enabled",
    reportFailure: false,
  });
  const [catalog, setCatalog] = useState<ServerProviderSkillCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [installingSkillKey, setInstallingSkillKey] = useState<string | null>(null);
  const [removingSkillKey, setRemovingSkillKey] = useState<string | null>(null);
  const [updatingSkillKey, setUpdatingSkillKey] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  const codexProviders = useMemo(() => providers.filter(isCodexProvider), [providers]);
  const installProvider = codexProviders[0] ?? null;
  const rows = useMemo<ReadonlyArray<CodexSkillRow>>(
    () =>
      codexProviders
        .flatMap((provider) =>
          provider.skills.map((skill) => ({ provider, skill }) satisfies CodexSkillRow),
        )
        .toSorted((left, right) => {
          const leftName = formatProviderSkillDisplayName(left.skill).toLowerCase();
          const rightName = formatProviderSkillDisplayName(right.skill).toLowerCase();
          return (
            providerLabel(left.provider).localeCompare(providerLabel(right.provider)) ||
            leftName.localeCompare(rightName) ||
            left.skill.path.localeCompare(right.skill.path)
          );
        }),
    [codexProviders],
  );
  const catalogEntries = catalog?.entries ?? [];
  const recommendedItems = useMemo(
    () => buildCatalogItems(catalogEntries, rows, "recommended"),
    [catalogEntries, rows],
  );
  const communityItems = useMemo(
    () => buildCatalogItems(catalogEntries, rows, "community"),
    [catalogEntries, rows],
  );
  const catalogSkillNames = useMemo(
    () => new Set(catalogEntries.map((entry) => entry.name)),
    [catalogEntries],
  );
  const otherRows = useMemo(
    () => rows.filter((row) => !catalogSkillNames.has(row.skill.name)),
    [catalogSkillNames, rows],
  );
  const disabledCount = rows.filter((row) => !row.skill.enabled).length;
  const installedCatalogCount =
    recommendedItems.filter((item) => item.installedRow).length +
    communityItems.filter((item) => item.installedRow).length;
  const installDisabled = installProvider === null || primaryEnvironmentId === null;

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      if (!primaryEnvironmentId) {
        setCatalog(null);
        return;
      }
      const result = unwrapAtomCommandResult(
        await listCatalogCommand({ environmentId: primaryEnvironmentId, input: {} }),
      );
      setCatalog(result.catalog);
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : "Failed to load skill catalog.");
    } finally {
      setCatalogLoading(false);
    }
  }, [listCatalogCommand, primaryEnvironmentId]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const installSkill = useCallback(
    async (source: { type: "catalog"; catalogEntryId: string } | { type: "url"; url: string }, key: string) => {
      if (!primaryEnvironmentId || !installProvider) {
        setOperationError("A Codex provider is required before installing skills.");
        return;
      }
      setInstallingSkillKey(key);
      setOperationError(null);
      try {
        unwrapAtomCommandResult(
          await installSkillCommand({
            environmentId: primaryEnvironmentId,
            input: {
              instanceId: installProvider.instanceId,
              source,
            },
          }),
        );
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : "Failed to install skill.");
      } finally {
        setInstallingSkillKey((current) => (current === key ? null : current));
      }
    },
    [installProvider, installSkillCommand, primaryEnvironmentId],
  );

  const installCatalogSkill = useCallback(
    async (entry: ServerProviderSkillCatalogEntry) => {
      await installSkill({ type: "catalog", catalogEntryId: entry.id }, `catalog:${entry.id}`);
    },
    [installSkill],
  );

  const installLinkedSkill = useCallback(async () => {
    const url = installUrl.trim();
    if (!url) {
      setOperationError("Enter a skill URL first.");
      return;
    }
    await installSkill({ type: "url", url }, "url");
    setInstallUrl("");
  }, [installSkill, installUrl]);

  const setSkillEnabled = useCallback(
    async (providerInstanceId: ProviderInstanceId, skill: ServerProviderSkill, enabled: boolean) => {
      if (!primaryEnvironmentId) return;
      const skillKey = `${providerInstanceId}:${skill.path || skill.name}`;
      setUpdatingSkillKey(skillKey);
      setOperationError(null);
      try {
        unwrapAtomCommandResult(
          await setSkillEnabledCommand({
            environmentId: primaryEnvironmentId,
            input: {
              instanceId: providerInstanceId,
              ...(skill.path ? { skillPath: skill.path } : { skillName: skill.name }),
              enabled,
            },
          }),
        );
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : "Failed to update skill.");
      } finally {
        setUpdatingSkillKey((current) => (current === skillKey ? null : current));
      }
    },
    [primaryEnvironmentId, setSkillEnabledCommand],
  );

  const removeSkill = useCallback(
    async (providerInstanceId: ProviderInstanceId, skill: ServerProviderSkill) => {
      if (!primaryEnvironmentId) return;
      const displayName = formatProviderSkillDisplayName(skill);
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Remove ${displayName}? This deletes the local skill folder that contains:\n\n${skill.path}`,
      );
      if (!confirmed) return;

      const skillKey = `${providerInstanceId}:${skill.path || skill.name}`;
      setRemovingSkillKey(skillKey);
      setOperationError(null);
      try {
        unwrapAtomCommandResult(
          await removeSkillCommand({
            environmentId: primaryEnvironmentId,
            input: {
              instanceId: providerInstanceId,
              skillPath: skill.path,
            },
          }),
        );
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : "Failed to remove skill.");
      } finally {
        setRemovingSkillKey((current) => (current === skillKey ? null : current));
      }
    },
    [primaryEnvironmentId, removeSkillCommand],
  );

  return (
    <SettingsPageContainer>
      <CatalogSkillSection
        title="Recommended Skills"
        icon={<SparklesIcon className="size-3.5" />}
        items={recommendedItems}
        emptyTitle={catalogLoading ? "Loading recommended skills" : "No recommended skills"}
        emptyDescription={
          catalogLoading
            ? "The UCSD skill catalog is loading."
            : "Recommended UCSD skills will appear here when the catalog is available."
        }
        installDisabled={installDisabled}
        installingSkillKey={installingSkillKey}
        updatingSkillKey={updatingSkillKey}
        removingSkillKey={removingSkillKey}
        onInstall={installCatalogSkill}
        onSetEnabled={setSkillEnabled}
        onRemove={removeSkill}
      />

      <CatalogSkillSection
        title="Community Skills"
        icon={<UsersIcon className="size-3.5" />}
        items={communityItems}
        emptyTitle={catalogLoading ? "Loading community skills" : "No community skills"}
        emptyDescription={
          catalogLoading
            ? "The UCSD skill catalog is loading."
            : "Community-created skills will appear here when the catalog is available."
        }
        installDisabled={installDisabled}
        installingSkillKey={installingSkillKey}
        updatingSkillKey={updatingSkillKey}
        removingSkillKey={removingSkillKey}
        onInstall={installCatalogSkill}
        onSetEnabled={setSkillEnabled}
        onRemove={removeSkill}
      />

      <SettingsSection
        title="Add From Link"
        icon={<LinkIcon className="size-3.5" />}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh skill catalog"
            disabled={catalogLoading}
            onClick={() => void loadCatalog()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        }
      >
        <SettingsRow
          title="Skill source URL"
          description="Install a GitHub skill folder, a GitHub SKILL.md file, or a hosted skill bundle."
        >
          <form
            className="mt-3 flex flex-col gap-2 pb-4 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void installLinkedSkill();
            }}
          >
            <Input
              nativeInput
              value={installUrl}
              placeholder="https://github.com/ucsd/.../tree/main/skill"
              aria-label="Skill source URL"
              disabled={installingSkillKey === "url"}
              onChange={(event) => setInstallUrl(event.currentTarget.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={installDisabled || installingSkillKey === "url"}
              className="sm:w-24"
            >
              <PlusIcon className="size-3.5" />
              {installingSkillKey === "url" ? "Adding..." : "Add"}
            </Button>
          </form>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Other Codex Skills"
        icon={<BookOpenIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{rows.length} installed</span>
            {installedCatalogCount > 0 ? <span>{installedCatalogCount} catalog</span> : null}
            {disabledCount > 0 ? <span>{disabledCount} disabled</span> : null}
          </div>
        }
      >
        {codexProviders.length === 0 ? (
          <div className="p-8">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpenIcon />
                </EmptyMedia>
                <EmptyTitle>No Codex provider found</EmptyTitle>
                <EmptyDescription>
                  TritonAI skills are installed into the managed Codex runtime.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : otherRows.length === 0 ? (
          <div className="p-8">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BookOpenIcon />
                </EmptyMedia>
                <EmptyTitle>No other skills</EmptyTitle>
                <EmptyDescription>
                  Skills from the UCSD catalog stay in Recommended or Community.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          otherRows.map((row) => (
            <SkillSettingsRow
              key={skillRowKey(row)}
              row={row}
              onSetEnabled={setSkillEnabled}
              onRemove={removeSkill}
              updating={updatingSkillKey === skillRowKey(row)}
              removing={removingSkillKey === skillRowKey(row)}
            />
          ))
        )}
      </SettingsSection>

      {catalogError ? (
        <SettingsSection title="Catalog Error">
          <SettingsRow title="Skill catalog failed to load" description={catalogError} />
        </SettingsSection>
      ) : null}

      {operationError ? (
        <SettingsSection title="Skill Error">
          <SettingsRow title="Skill operation failed" description={operationError} />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
