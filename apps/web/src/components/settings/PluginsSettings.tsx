import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ServerPluginMarketplace,
  ServerPluginMarketplaceLoadError,
  ServerPluginSummary,
  ServerPluginsListResult,
} from "@t3tools/contracts";
import {
  DownloadIcon,
  PackageIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface PluginRow {
  readonly marketplace: ServerPluginMarketplace;
  readonly plugin: ServerPluginSummary;
}

function unwrapAtomCommandResult<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }
  return result.value;
}

function pluginDisplayName(plugin: ServerPluginSummary): string {
  return plugin.displayName ?? plugin.name;
}

function marketplaceDisplayName(marketplace: ServerPluginMarketplace): string {
  return marketplace.displayName ?? marketplace.name;
}

function pluginRowKey(row: PluginRow): string {
  return `${row.plugin.marketplaceName}:${row.plugin.id}`;
}

function pluginStatus(plugin: ServerPluginSummary): {
  readonly label: "Available" | "Disabled" | "Installed" | "Unavailable";
  readonly variant: "outline" | "success" | "warning";
} {
  if (plugin.availability === "DISABLED_BY_ADMIN") {
    return { label: "Unavailable", variant: "warning" };
  }
  if (!plugin.installed) {
    return { label: "Available", variant: "outline" };
  }
  return plugin.enabled
    ? { label: "Installed", variant: "success" }
    : { label: "Disabled", variant: "warning" };
}

function pluginSourceLabel(plugin: ServerPluginSummary): string {
  switch (plugin.source.type) {
    case "local":
      return plugin.source.path;
    case "git":
      return plugin.source.refName
        ? `${plugin.source.url}#${plugin.source.refName}`
        : plugin.source.url;
    case "remote":
      return "Remote catalog";
  }
}

function buildPluginRows(
  plugins: ServerPluginsListResult | null,
  installed: boolean,
): ReadonlyArray<PluginRow> {
  return (plugins?.marketplaces ?? [])
    .flatMap((marketplace) =>
      marketplace.plugins
        .filter((plugin) => plugin.installed === installed)
        .map((plugin) => ({ marketplace, plugin }) satisfies PluginRow),
    )
    .toSorted((left, right) => {
      const marketplaceOrder = marketplaceDisplayName(left.marketplace).localeCompare(
        marketplaceDisplayName(right.marketplace),
      );
      return (
        marketplaceOrder ||
        pluginDisplayName(left.plugin).localeCompare(pluginDisplayName(right.plugin))
      );
    });
}

function MarketplaceRow({
  marketplace,
  upgrading,
  removing,
  onUpgrade,
  onRemove,
}: {
  readonly marketplace: ServerPluginMarketplace;
  readonly upgrading: boolean;
  readonly removing: boolean;
  readonly onUpgrade: (marketplaceName: string) => Promise<void>;
  readonly onRemove: (marketplace: ServerPluginMarketplace) => Promise<void>;
}) {
  const pluginCount = marketplace.plugins.length;
  const installedCount = marketplace.plugins.filter((plugin) => plugin.installed).length;

  return (
    <SettingsRow
      title={marketplaceDisplayName(marketplace)}
      description={`${pluginCount} plugins, ${installedCount} installed`}
      status={
        marketplace.path ? (
          <code className="block truncate font-mono text-[10px] text-muted-foreground/70">
            {marketplace.path}
          </code>
        ) : (
          <span>Remote catalog</span>
        )
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={`Upgrade ${marketplaceDisplayName(marketplace)}`}
            disabled={upgrading || removing}
            onClick={() => void onUpgrade(marketplace.name)}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            className="text-muted-foreground"
            aria-label={`Remove ${marketplaceDisplayName(marketplace)}`}
            disabled={upgrading || removing}
            onClick={() => void onRemove(marketplace)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      }
    />
  );
}

function PluginSettingsRow({
  row,
  installing,
  uninstalling,
  onInstall,
  onUninstall,
}: {
  readonly row: PluginRow;
  readonly installing: boolean;
  readonly uninstalling: boolean;
  readonly onInstall: (row: PluginRow) => Promise<void>;
  readonly onUninstall: (row: PluginRow) => Promise<void>;
}) {
  const status = pluginStatus(row.plugin);
  const displayName = pluginDisplayName(row.plugin);
  const description =
    row.plugin.description ??
    row.plugin.category ??
    `${marketplaceDisplayName(row.marketplace)} plugin`;
  const sourceDetails = [
    marketplaceDisplayName(row.marketplace),
    row.plugin.developerName,
    row.plugin.localVersion ? `v${row.plugin.localVersion}` : null,
  ].filter(Boolean);

  return (
    <SettingsRow
      title={
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate">{displayName}</span>
          <Badge size="sm" variant={status.variant}>
            {status.label}
          </Badge>
        </span>
      }
      description={description}
      status={
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate">{sourceDetails.join(" / ")}</span>
          <code className="block truncate font-mono text-[10px] text-muted-foreground/70">
            {pluginSourceLabel(row.plugin)}
          </code>
        </div>
      }
      control={
        row.plugin.installed ? (
          <Button
            size="icon-xs"
            variant="outline"
            className="text-muted-foreground"
            aria-label={`Uninstall ${displayName}`}
            disabled={uninstalling}
            onClick={() => void onUninstall(row)}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={installing || status.label === "Unavailable"}
            onClick={() => void onInstall(row)}
          >
            <DownloadIcon className="size-3.5" />
            {installing ? "Adding..." : "Install"}
          </Button>
        )
      }
    />
  );
}

function PluginSection({
  title,
  icon,
  rows,
  emptyTitle,
  emptyDescription,
  mutatingKey,
  onInstall,
  onUninstall,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly rows: ReadonlyArray<PluginRow>;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly mutatingKey: string | null;
  readonly onInstall: (row: PluginRow) => Promise<void>;
  readonly onUninstall: (row: PluginRow) => Promise<void>;
}) {
  return (
    <SettingsSection
      title={title}
      icon={icon}
      headerAction={<span className="text-[11px] text-muted-foreground">{rows.length}</span>}
    >
      {rows.length === 0 ? (
        <div className="p-8">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PuzzleIcon />
              </EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
              <EmptyDescription>{emptyDescription}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        rows.map((row) => (
          <PluginSettingsRow
            key={pluginRowKey(row)}
            row={row}
            installing={mutatingKey === `install:${pluginRowKey(row)}`}
            uninstalling={mutatingKey === `uninstall:${pluginRowKey(row)}`}
            onInstall={onInstall}
            onUninstall={onUninstall}
          />
        ))
      )}
    </SettingsSection>
  );
}

function MarketplaceErrorSection({
  errors,
}: {
  readonly errors: ReadonlyArray<ServerPluginMarketplaceLoadError>;
}) {
  if (errors.length === 0) return null;

  return (
    <SettingsSection title="Marketplace Errors">
      {errors.map((error) => (
        <SettingsRow
          key={error.marketplacePath}
          title="Marketplace failed to load"
          description={error.message}
          status={
            <code className="block truncate font-mono text-[10px] text-muted-foreground/70">
              {error.marketplacePath}
            </code>
          }
        />
      ))}
    </SettingsSection>
  );
}

export function PluginsSettingsPanel() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const listPluginsCommand = useAtomCommand(serverEnvironment.listPlugins, {
    label: "plugin list",
    reportFailure: false,
  });
  const installPluginCommand = useAtomCommand(serverEnvironment.installPlugin, {
    label: "plugin install",
    reportFailure: false,
  });
  const uninstallPluginCommand = useAtomCommand(serverEnvironment.uninstallPlugin, {
    label: "plugin uninstall",
    reportFailure: false,
  });
  const addMarketplaceCommand = useAtomCommand(serverEnvironment.addMarketplace, {
    label: "marketplace add",
    reportFailure: false,
  });
  const removeMarketplaceCommand = useAtomCommand(serverEnvironment.removeMarketplace, {
    label: "marketplace remove",
    reportFailure: false,
  });
  const upgradeMarketplaceCommand = useAtomCommand(serverEnvironment.upgradeMarketplace, {
    label: "marketplace upgrade",
    reportFailure: false,
  });

  const [plugins, setPlugins] = useState<ServerPluginsListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [mutatingKey, setMutatingKey] = useState<string | null>(null);

  const installedRows = useMemo(() => buildPluginRows(plugins, true), [plugins]);
  const availableRows = useMemo(() => buildPluginRows(plugins, false), [plugins]);
  const marketplaces = plugins?.marketplaces ?? [];
  const unavailable = primaryEnvironmentId === null;

  const loadPlugins = useCallback(async () => {
    if (!primaryEnvironmentId) {
      setPlugins(null);
      return;
    }
    setLoading(true);
    setOperationError(null);
    try {
      const result = unwrapAtomCommandResult(
        await listPluginsCommand({
          environmentId: primaryEnvironmentId,
          input: { includeRemote: true },
        }),
      );
      setPlugins(result);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Failed to load plugins.");
    } finally {
      setLoading(false);
    }
  }, [listPluginsCommand, primaryEnvironmentId]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const installPlugin = useCallback(
    async (row: PluginRow) => {
      if (!primaryEnvironmentId) return;
      const key = `install:${pluginRowKey(row)}`;
      setMutatingKey(key);
      setOperationError(null);
      try {
        const result = unwrapAtomCommandResult(
          await installPluginCommand({
            environmentId: primaryEnvironmentId,
            input: {
              pluginName: row.plugin.name,
              ...(row.plugin.marketplacePath
                ? { marketplacePath: row.plugin.marketplacePath }
                : { remoteMarketplaceName: row.plugin.marketplaceName }),
            },
          }),
        );
        setPlugins(result);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : "Failed to install plugin.");
      } finally {
        setMutatingKey((current) => (current === key ? null : current));
      }
    },
    [installPluginCommand, primaryEnvironmentId],
  );

  const uninstallPlugin = useCallback(
    async (row: PluginRow) => {
      if (!primaryEnvironmentId) return;
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Uninstall ${pluginDisplayName(row.plugin)}?`,
      );
      if (!confirmed) return;

      const key = `uninstall:${pluginRowKey(row)}`;
      setMutatingKey(key);
      setOperationError(null);
      try {
        const result = unwrapAtomCommandResult(
          await uninstallPluginCommand({
            environmentId: primaryEnvironmentId,
            input: { pluginId: row.plugin.id },
          }),
        );
        setPlugins(result);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : "Failed to uninstall plugin.");
      } finally {
        setMutatingKey((current) => (current === key ? null : current));
      }
    },
    [primaryEnvironmentId, uninstallPluginCommand],
  );

  const addMarketplace = useCallback(async () => {
    const source = marketplaceSource.trim();
    if (!primaryEnvironmentId || !source) return;

    setMutatingKey("marketplace:add");
    setOperationError(null);
    try {
      const result = unwrapAtomCommandResult(
        await addMarketplaceCommand({
          environmentId: primaryEnvironmentId,
          input: { source },
        }),
      );
      setPlugins(result);
      setMarketplaceSource("");
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Failed to add marketplace.");
    } finally {
      setMutatingKey((current) => (current === "marketplace:add" ? null : current));
    }
  }, [addMarketplaceCommand, marketplaceSource, primaryEnvironmentId]);

  const removeMarketplace = useCallback(
    async (marketplace: ServerPluginMarketplace) => {
      if (!primaryEnvironmentId) return;
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `Remove ${marketplaceDisplayName(marketplace)}?`,
      );
      if (!confirmed) return;

      const key = `marketplace:remove:${marketplace.name}`;
      setMutatingKey(key);
      setOperationError(null);
      try {
        const result = unwrapAtomCommandResult(
          await removeMarketplaceCommand({
            environmentId: primaryEnvironmentId,
            input: { marketplaceName: marketplace.name },
          }),
        );
        setPlugins(result);
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : "Failed to remove marketplace.");
      } finally {
        setMutatingKey((current) => (current === key ? null : current));
      }
    },
    [primaryEnvironmentId, removeMarketplaceCommand],
  );

  const upgradeMarketplace = useCallback(
    async (marketplaceName?: string) => {
      if (!primaryEnvironmentId) return;
      const key = marketplaceName ? `marketplace:upgrade:${marketplaceName}` : "marketplace:upgrade";
      setMutatingKey(key);
      setOperationError(null);
      try {
        const result = unwrapAtomCommandResult(
          await upgradeMarketplaceCommand({
            environmentId: primaryEnvironmentId,
            input: marketplaceName ? { marketplaceName } : {},
          }),
        );
        setPlugins(result);
      } catch (error) {
        setOperationError(
          error instanceof Error ? error.message : "Failed to upgrade marketplaces.",
        );
      } finally {
        setMutatingKey((current) => (current === key ? null : current));
      }
    },
    [primaryEnvironmentId, upgradeMarketplaceCommand],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Marketplaces"
        icon={<PackageIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-1.5">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh plugins"
              disabled={loading || unavailable}
              onClick={() => void loadPlugins()}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Upgrade marketplaces"
              disabled={mutatingKey === "marketplace:upgrade" || unavailable}
              onClick={() => void upgradeMarketplace()}
            >
              <DownloadIcon className="size-3.5" />
            </Button>
          </div>
        }
      >
        <SettingsRow title="Add marketplace" description="Git URL, local path, or marketplace file">
          <form
            className="mt-3 flex flex-col gap-2 pb-4 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void addMarketplace();
            }}
          >
            <Input
              nativeInput
              value={marketplaceSource}
              placeholder="https://github.com/ucsd/... or /path/to/marketplace"
              aria-label="Marketplace source"
              disabled={mutatingKey === "marketplace:add"}
              onChange={(event) => setMarketplaceSource(event.currentTarget.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={unavailable || mutatingKey === "marketplace:add" || !marketplaceSource.trim()}
              className="sm:w-24"
            >
              <PlusIcon className="size-3.5" />
              {mutatingKey === "marketplace:add" ? "Adding..." : "Add"}
            </Button>
          </form>
        </SettingsRow>
        {marketplaces.length === 0 ? (
          <div className="border-t border-border/60 p-8">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PackageIcon />
                </EmptyMedia>
                <EmptyTitle>{loading ? "Loading marketplaces" : "No marketplaces"}</EmptyTitle>
                <EmptyDescription>
                  Codex marketplaces will appear here when the runtime reports them.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          marketplaces.map((marketplace) => (
            <MarketplaceRow
              key={marketplace.name}
              marketplace={marketplace}
              upgrading={mutatingKey === `marketplace:upgrade:${marketplace.name}`}
              removing={mutatingKey === `marketplace:remove:${marketplace.name}`}
              onUpgrade={upgradeMarketplace}
              onRemove={removeMarketplace}
            />
          ))
        )}
      </SettingsSection>

      <PluginSection
        title="Installed Plugins"
        icon={<PuzzleIcon className="size-3.5" />}
        rows={installedRows}
        emptyTitle={loading ? "Loading plugins" : "No installed plugins"}
        emptyDescription="Installed Codex plugins will appear here."
        mutatingKey={mutatingKey}
        onInstall={installPlugin}
        onUninstall={uninstallPlugin}
      />

      <PluginSection
        title="Available Plugins"
        icon={<DownloadIcon className="size-3.5" />}
        rows={availableRows}
        emptyTitle={loading ? "Loading plugins" : "No available plugins"}
        emptyDescription="Available Codex marketplace plugins will appear here."
        mutatingKey={mutatingKey}
        onInstall={installPlugin}
        onUninstall={uninstallPlugin}
      />

      <MarketplaceErrorSection errors={plugins?.marketplaceLoadErrors ?? []} />

      {operationError ? (
        <SettingsSection title="Plugin Error">
          <SettingsRow title="Plugin operation failed" description={operationError} />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
