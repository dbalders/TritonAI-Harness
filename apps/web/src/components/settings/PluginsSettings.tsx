import type {
  IntegrationConnectResult,
  IntegrationSummary,
  IntegrationsListResult,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CheckCircle2Icon,
  PlugIcon,
  PuzzleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UnplugIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  integrationFlowIsActive,
  scheduleIntegrationFlow,
  type ScheduledIntegrationFlow,
  withIntegrationPollDelay,
} from "./integrationPolling";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The plugin operation failed.";
}

function statusVariant(state: IntegrationSummary["connectionState"]) {
  if (state === "connected") return "success" as const;
  if (state === "error") return "destructive" as const;
  if (state === "connecting") return "warning" as const;
  return "outline" as const;
}

type PollIntegrationFlow = (
  id: string,
  flow: ScheduledIntegrationFlow,
  cancelled: () => boolean,
) => Promise<void>;

const PANEL_ERROR = "__panel";

function IntegrationFlowPoller({
  id,
  flow,
  poll,
}: {
  readonly id: string;
  readonly flow: ScheduledIntegrationFlow;
  readonly poll: PollIntegrationFlow;
}) {
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(
      () => void poll(id, flow, () => cancelled),
      Math.max(0, flow.nextPollAtMilliseconds - Date.now()),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flow, id, poll]);
  return null;
}

function IntegrationCard({
  integration,
  busy,
  flow,
  selectedCapabilities,
  onSelectedCapabilities,
  onAction,
}: {
  readonly integration: IntegrationSummary;
  readonly busy: boolean;
  readonly flow: IntegrationConnectResult | null;
  readonly selectedCapabilities: ReadonlySet<string>;
  readonly onSelectedCapabilities: (value: ReadonlySet<string>) => void;
  readonly onAction: (
    action: "install" | "enable" | "disable" | "connect" | "disconnect" | "remove",
    integration: IntegrationSummary,
  ) => Promise<void>;
}) {
  const selectable = integration.capabilities.filter((capability) => !capability.granted);
  const toggleCapability = (id: string, checked: boolean) => {
    const next = new Set(selectedCapabilities);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedCapabilities(next);
  };

  return (
    <article
      className="border-t border-border/60 p-4 first:border-t-0 sm:p-5"
      aria-labelledby={`${integration.id}-title`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`${integration.id}-title`} className="text-sm font-semibold">
              {integration.name}
            </h3>
            <Badge size="sm" variant={statusVariant(integration.connectionState)}>
              {integration.installed
                ? integration.enabled
                  ? integration.connectionState.replace("_", " ")
                  : "disabled"
                : "available"}
            </Badge>
            <Badge size="sm" variant="outline">
              v{integration.version}
            </Badge>
          </div>
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {integration.description}
          </p>
          {integration.accountLabel ? (
            <p className="text-xs font-medium">{integration.accountLabel}</p>
          ) : null}
          {integration.compatibilityMessage ? (
            <p className="text-xs text-destructive">{integration.compatibilityMessage}</p>
          ) : null}
          {integration.statusMessage ? (
            <p
              className={
                integration.connectionState === "error"
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
              role={integration.connectionState === "error" ? "alert" : "status"}
            >
              {integration.statusMessage}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!integration.installed ? (
            <Button
              size="sm"
              disabled={busy || !integration.compatible}
              onClick={() => void onAction("install", integration)}
            >
              <PlugIcon /> Install
            </Button>
          ) : (
            <>
              <label className="inline-flex items-center gap-2 text-xs font-medium">
                <Switch
                  checked={integration.enabled}
                  disabled={busy}
                  aria-label={`${integration.name} enabled`}
                  onCheckedChange={(checked) =>
                    void onAction(checked ? "enable" : "disable", integration)
                  }
                />
                Enabled
              </label>
              {integration.connectionState === "connected" ||
              integration.connectionState === "error" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void onAction("disconnect", integration)}
                >
                  <UnplugIcon /> Disconnect
                </Button>
              ) : null}
              <Button
                size="icon-sm"
                variant="outline"
                className="text-destructive"
                disabled={busy}
                aria-label={`Remove ${integration.name}`}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${integration.name}? Its server-side credentials will also be deleted.`,
                    )
                  )
                    void onAction("remove", integration);
                }}
              >
                <Trash2Icon />
              </Button>
            </>
          )}
        </div>
      </div>

      {integration.installed ? (
        <div className="mt-4 grid gap-4 border-t border-border/60 pt-4 lg:grid-cols-3">
          <div className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold">
              <ShieldCheckIcon className="size-3.5" /> Permissions
            </h4>
            {integration.capabilities.map((capability) => (
              <label
                key={capability.id}
                className="flex items-start gap-2 rounded-lg border p-2.5 text-xs"
              >
                <Checkbox
                  checked={capability.granted || selectedCapabilities.has(capability.id)}
                  disabled={busy || flow !== null || capability.granted || !integration.enabled}
                  onCheckedChange={(checked) => toggleCapability(capability.id, Boolean(checked))}
                  aria-label={`${capability.displayName} permission`}
                />
                <span>
                  <span className="block font-medium">{capability.displayName}</span>
                  <span className="text-muted-foreground">{capability.description}</span>
                </span>
              </label>
            ))}
            {integration.enabled && selectable.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || flow !== null || selectedCapabilities.size === 0}
                onClick={() => void onAction("connect", integration)}
              >
                {integration.connectionState === "connected" ? "Add permissions" : "Connect"}
              </Button>
            ) : null}
          </div>
          <div className="space-y-2">
            <h4 className="flex items-center gap-1.5 text-xs font-semibold">
              <PuzzleIcon className="size-3.5" /> Tools
            </h4>
            {integration.tools.length > 0 ? (
              integration.tools.map((tool) => (
                <div key={tool.name} className="rounded-lg bg-muted/40 p-2.5 text-xs">
                  <span className="flex items-center gap-1.5 font-medium">
                    <PuzzleIcon className="size-3" />
                    {tool.displayName}
                    {tool.available ? (
                      <CheckCircle2Icon
                        className="size-3 text-emerald-600"
                        aria-label="Available"
                      />
                    ) : null}
                  </span>
                  <span className="text-muted-foreground">{tool.description}</span>
                </div>
              ))
            ) : (
              <p className="rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
                No tools. This plugin contributes instructions only.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <h4 className="text-xs font-semibold">Bundled skills</h4>
            {integration.skills.map((skill) => (
              <div key={skill.name} className="rounded-lg bg-muted/40 p-2.5 text-xs">
                <span className="font-medium">{skill.name}</span>
                <p className="text-muted-foreground">{skill.description}</p>
                <span className={skill.available ? "text-emerald-600" : "text-muted-foreground"}>
                  {skill.available ? "Available" : "Unavailable until active"}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {flow ? (
        <div
          className="mt-4 rounded-xl border border-primary/30 bg-primary/5 p-4"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm font-semibold">Finish signing in to {integration.name}</p>
          <p className="mt-1 text-xs text-muted-foreground">{flow.message}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="rounded bg-background px-3 py-1.5 text-sm font-semibold tracking-widest">
              {flow.userCode}
            </code>
            <Button
              size="sm"
              render={
                <a
                  href={flow.verificationUriComplete ?? flow.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              Open sign-in
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function PluginsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const environmentIdRef = useRef(environmentId);
  environmentIdRef.current = environmentId;
  const listCommand = useAtomCommand(serverEnvironment.listIntegrations, { reportFailure: false });
  const installCommand = useAtomCommand(serverEnvironment.installIntegration, {
    reportFailure: false,
  });
  const enabledCommand = useAtomCommand(serverEnvironment.setIntegrationEnabled, {
    reportFailure: false,
  });
  const connectCommand = useAtomCommand(serverEnvironment.connectIntegration, {
    reportFailure: false,
  });
  const pollCommand = useAtomCommand(serverEnvironment.pollIntegration, { reportFailure: false });
  const disconnectCommand = useAtomCommand(serverEnvironment.disconnectIntegration, {
    reportFailure: false,
  });
  const removeCommand = useAtomCommand(serverEnvironment.removeIntegration, {
    reportFailure: false,
  });
  const [data, setData] = useState<IntegrationsListResult>({ integrations: [] });
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flows, setFlows] = useState<Record<string, ScheduledIntegrationFlow>>({});
  const [selections, setSelections] = useState<Record<string, ReadonlySet<string>>>({});

  useEffect(() => {
    setData({ integrations: [] });
    setFlows({});
    setSelections({});
    setBusyIds(new Set());
    setErrors({});
    setLoading(environmentId !== null);
  }, [environmentId]);

  const load = useCallback(async () => {
    if (!environmentId) return;
    const targetEnvironmentId = environmentId;
    setLoading(true);
    try {
      const result = unwrap(await listCommand({ environmentId: targetEnvironmentId, input: {} }));
      if (environmentIdRef.current !== targetEnvironmentId) return;
      setData(result);
      setErrors((current) => {
        const { [PANEL_ERROR]: _, ...rest } = current;
        return rest;
      });
    } catch (cause) {
      if (environmentIdRef.current !== targetEnvironmentId) return;
      setErrors((current) => ({ ...current, [PANEL_ERROR]: errorMessage(cause) }));
    } finally {
      if (environmentIdRef.current === targetEnvironmentId) setLoading(false);
    }
  }, [environmentId, listCommand]);

  useEffect(() => {
    void load();
  }, [load]);

  const pollFlow = useCallback<PollIntegrationFlow>(
    async (id, flow, cancelled) => {
      if (!environmentId) return;
      const targetEnvironmentId = environmentId;
      try {
        const result = unwrap(
          await pollCommand({
            environmentId: targetEnvironmentId,
            input: { id, flowId: flow.flowId },
          }),
        );
        if (cancelled() || environmentIdRef.current !== targetEnvironmentId) return;
        setData((current) => ({
          integrations: current.integrations.map((item) =>
            item.id === id ? result.integration : item,
          ),
        }));
        setErrors((current) => {
          const { [id]: _, ...rest } = current;
          return rest;
        });
        if (result.state !== "pending") {
          if (result.state === "failed" || result.state === "expired") {
            setErrors((current) => ({
              ...current,
              [id]: result.message ?? "Plugin sign-in did not complete. Start again.",
            }));
          } else {
            setSelections((current) => {
              const { [id]: _, ...rest } = current;
              return rest;
            });
          }
          setFlows((current) => {
            const { [id]: _, ...rest } = current;
            return rest;
          });
        } else {
          setFlows((current) => ({
            ...current,
            [id]: scheduleIntegrationFlow(withIntegrationPollDelay(flow, result.retryAfterSeconds)),
          }));
        }
      } catch (cause) {
        if (cancelled() || environmentIdRef.current !== targetEnvironmentId) return;
        setErrors((current) => ({ ...current, [id]: errorMessage(cause) }));
        if (integrationFlowIsActive(flow, Date.now())) {
          setFlows((current) => ({ ...current, [id]: scheduleIntegrationFlow(flow) }));
        } else {
          setFlows((current) => {
            const { [id]: _, ...rest } = current;
            return rest;
          });
        }
      }
    },
    [environmentId, pollCommand],
  );

  const action = useCallback(
    async (
      kind: "install" | "enable" | "disable" | "connect" | "disconnect" | "remove",
      integration: IntegrationSummary,
    ) => {
      if (!environmentId) return;
      const targetEnvironmentId = environmentId;
      setBusyIds((current) => new Set(current).add(integration.id));
      setErrors((current) => {
        const { [integration.id]: _, ...rest } = current;
        return rest;
      });
      try {
        if (kind === "connect") {
          const capabilities = [...(selections[integration.id] ?? new Set<string>())];
          const flow = unwrap(
            await connectCommand({
              environmentId: targetEnvironmentId,
              input: { id: integration.id, capabilities },
            }),
          );
          if (environmentIdRef.current !== targetEnvironmentId) return;
          setFlows((current) => ({
            ...current,
            [integration.id]: scheduleIntegrationFlow(flow),
          }));
        } else {
          const command =
            kind === "install"
              ? installCommand({
                  environmentId: targetEnvironmentId,
                  input: { id: integration.id },
                })
              : kind === "enable" || kind === "disable"
                ? enabledCommand({
                    environmentId: targetEnvironmentId,
                    input: { id: integration.id, enabled: kind === "enable" },
                  })
                : kind === "disconnect"
                  ? disconnectCommand({
                      environmentId: targetEnvironmentId,
                      input: { id: integration.id },
                    })
                  : removeCommand({
                      environmentId: targetEnvironmentId,
                      input: { id: integration.id },
                    });
          const result = unwrap(await command);
          if (environmentIdRef.current !== targetEnvironmentId) return;
          setData(result);
          if (kind === "disable" || kind === "disconnect" || kind === "remove") {
            setFlows((current) => {
              const { [integration.id]: _, ...rest } = current;
              return rest;
            });
          }
          if (kind === "remove") {
            setSelections((current) => {
              const { [integration.id]: _, ...rest } = current;
              return rest;
            });
          }
        }
      } catch (cause) {
        if (environmentIdRef.current !== targetEnvironmentId) return;
        setErrors((current) => ({ ...current, [integration.id]: errorMessage(cause) }));
      } finally {
        if (environmentIdRef.current === targetEnvironmentId) {
          setBusyIds((current) => {
            const next = new Set(current);
            next.delete(integration.id);
            return next;
          });
        }
      }
    },
    [
      connectCommand,
      disconnectCommand,
      enabledCommand,
      environmentId,
      installCommand,
      removeCommand,
      selections,
    ],
  );

  const installed = useMemo(() => data.integrations.filter((item) => item.installed), [data]);
  const available = useMemo(() => data.integrations.filter((item) => !item.installed), [data]);
  const renderCards = (items: ReadonlyArray<IntegrationSummary>) =>
    items.map((integration) => (
      <IntegrationCard
        key={integration.id}
        integration={integration}
        busy={busyIds.has(integration.id)}
        flow={flows[integration.id] ?? null}
        selectedCapabilities={selections[integration.id] ?? new Set()}
        onSelectedCapabilities={(value) =>
          setSelections((current) => ({ ...current, [integration.id]: value }))
        }
        onAction={action}
      />
    ));

  return (
    <SettingsPageContainer>
      {Object.entries(flows).map(([id, flow]) => (
        <IntegrationFlowPoller key={`${id}:${flow.flowId}`} id={id} flow={flow} poll={pollFlow} />
      ))}
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Plugins</h1>
        <p className="text-xs text-muted-foreground">
          Install and connect provider-neutral Harness plugins. Credentials remain on this server.
        </p>
      </div>
      {Object.keys(errors).length > 0 ? (
        <div
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
          role="alert"
        >
          {Object.entries(errors).map(([owner, message]) => (
            <p key={owner}>{message}</p>
          ))}
        </div>
      ) : null}
      <SettingsSection
        title="Installed"
        icon={<PlugIcon className="size-3.5" />}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh plugins"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCwIcon className={loading ? "animate-spin" : ""} />
          </Button>
        }
      >
        {installed.length ? (
          renderCards(installed)
        ) : (
          <p className="p-6 text-center text-xs text-muted-foreground">No plugins installed.</p>
        )}
      </SettingsSection>
      <SettingsSection
        title="Available"
        icon={<PuzzleIcon className="size-3.5" />}
        headerAction={<span className="text-[11px] text-muted-foreground">{available.length}</span>}
      >
        {available.length ? (
          renderCards(available)
        ) : (
          <p className="p-6 text-center text-xs text-muted-foreground">
            All available plugins are installed.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
