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
  ChevronDownIcon,
  InfoIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
  PlugIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SparklesIcon,
  UnplugIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  integrationFlowIsActive,
  scheduleIntegrationFlow,
  type ScheduledIntegrationFlow,
  updateIntegrationFlowIfCurrent,
  withIntegrationPollDelay,
} from "./integrationPolling";

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The plugin operation failed.";
}

function connectionLabel(integration: IntegrationSummary): string {
  if (!integration.enabled) return "Plugin off";
  if (integration.connectionState === "not_connected") return "Not connected";
  return integration.connectionState.replace("_", " ");
}

function connectionVariant(integration: IntegrationSummary) {
  if (!integration.enabled) return "outline" as const;
  if (integration.connectionState === "connected") return "success" as const;
  if (integration.connectionState === "error") return "destructive" as const;
  if (integration.connectionState === "connecting") return "warning" as const;
  return "outline" as const;
}

export function integrationNeedsConnectionAction(integration: IntegrationSummary): boolean {
  const needsAuthorization = integration.capabilities.some(
    ({ enabled, granted }) => enabled && !granted,
  );
  return (
    integration.installed &&
    integration.enabled &&
    integration.compatible &&
    integration.requiresConnection &&
    integration.capabilities.some(({ enabled }) => enabled) &&
    (integration.connectionState === "not_connected" ||
      integration.connectionState === "error" ||
      needsAuthorization)
  );
}

export function shouldExpandIntegrationCard(input: {
  readonly needsConnectionAction: boolean;
  readonly hasFlow: boolean;
  readonly connectionAttentionRequest?: number;
}): boolean {
  return (
    input.needsConnectionAction || input.hasFlow || input.connectionAttentionRequest !== undefined
  );
}

export function shouldFocusConnectionAction(input: {
  readonly expanded: boolean;
  readonly connectionAttentionRequest?: number;
  readonly handledAttentionRequest?: number;
}): boolean {
  return (
    input.expanded &&
    input.connectionAttentionRequest !== undefined &&
    input.handledAttentionRequest !== input.connectionAttentionRequest
  );
}

interface ConnectionAttentionState {
  readonly attention: { readonly id: string; readonly request: number } | null;
  readonly announcement: string;
}

export function clearOwnedConnectionAttention(
  current: ConnectionAttentionState,
  integrationId: string,
): ConnectionAttentionState {
  if (current.attention?.id !== integrationId) return current;
  return { attention: null, announcement: "" };
}

export function reconcileConnectionAttentionForIntegration(
  current: ConnectionAttentionState,
  integrationId: string,
  integration: IntegrationSummary | undefined,
): ConnectionAttentionState {
  return integration && integrationNeedsConnectionAction(integration)
    ? current
    : clearOwnedConnectionAttention(current, integrationId);
}

export function IntegrationConnectionActionCallout({
  integrationName,
}: {
  readonly integrationName: string;
}) {
  return (
    <p className="mt-1 text-xs font-semibold" role="status" aria-live="polite">
      Action required: Connect {integrationName}
    </p>
  );
}

export function integrationConnectAriaLabel(integrationName: string): string {
  return `Connect ${integrationName}`;
}

export function capabilityUsesWriteTool(
  integration: IntegrationSummary,
  capabilityId: string,
): boolean {
  return integration.tools.some(
    (tool) => tool.effect === "write" && tool.capabilities.includes(capabilityId),
  );
}

export function capabilityAccessStateLabel(
  integration: IntegrationSummary,
  capability: IntegrationSummary["capabilities"][number],
): string {
  if (capability.available) return "Active";
  if (capability.enabled && !capability.granted && integration.requiresConnection) {
    return "Authorization required";
  }
  return capability.enabled ? "Unavailable" : "Off";
}

type PollIntegrationFlow = (
  id: string,
  flow: ScheduledIntegrationFlow,
  cancelled: () => boolean,
) => Promise<void>;

type ActiveIntegrationFlow =
  | ScheduledIntegrationFlow
  | Exclude<IntegrationConnectResult, { readonly kind: "device_code" }>;

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

function PluginDetailSection({
  title,
  count,
  icon,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <h4 className="flex items-center gap-2 border-b border-border/60 pb-2 text-sm font-semibold">
        {icon}
        {title}
        {count === undefined ? null : (
          <span className="font-normal text-muted-foreground">{count}</span>
        )}
      </h4>
      {children}
    </section>
  );
}

function assertNever(value: never): never {
  throw new Error(`Unsupported integration authorization flow: ${String(value)}`);
}

function IntegrationAuthorizationFlow({
  integrationName,
  flow,
  busy,
  onApiKeySubmit,
}: {
  readonly integrationName: string;
  readonly flow: IntegrationConnectResult;
  readonly busy: boolean;
  readonly onApiKeySubmit: (flowId: string, value: string) => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setApiKey("");
  }, [flow.flowId]);

  switch (flow.kind) {
    case "device_code":
      return (
        <div
          className="mt-2 rounded-xl border border-primary/30 bg-primary/5 p-4"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm font-semibold">Finish signing in to {integrationName}</p>
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
      );
    case "api_key":
      return (
        <form
          className="mt-2 rounded-xl border border-primary/30 bg-primary/5 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (apiKey.length > 0) void onApiKeySubmit(flow.flowId, apiKey);
          }}
        >
          <p className="text-sm font-semibold">Connect {integrationName}</p>
          <p className="mt-1 text-xs text-muted-foreground">{flow.message}</p>
          <label className="mt-3 block text-xs font-medium" htmlFor={`${flow.flowId}-api-key`}>
            {flow.label}
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id={`${flow.flowId}-api-key`}
              nativeInput
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={16_384}
              placeholder={flow.placeholder ?? undefined}
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              disabled={busy}
              aria-label={flow.label}
            />
            <Button type="submit" size="sm" disabled={busy || apiKey.length === 0}>
              Connect
            </Button>
          </div>
        </form>
      );
    case "connected":
      return (
        <p className="mt-2 text-xs text-success" role="status">
          {flow.message}
        </p>
      );
    default:
      return assertNever(flow);
  }
}

function IntegrationCard({
  integration,
  busy,
  flow,
  onAction,
  onApiKeySubmit,
  onCapabilityEnabled,
  connectionAttentionRequest,
}: {
  readonly integration: IntegrationSummary;
  readonly busy: boolean;
  readonly flow: IntegrationConnectResult | null;
  readonly onAction: (
    action: "enable" | "disable" | "connect" | "disconnect",
    integration: IntegrationSummary,
  ) => Promise<void>;
  readonly onApiKeySubmit: (
    integration: IntegrationSummary,
    flowId: string,
    value: string,
  ) => Promise<void>;
  readonly onCapabilityEnabled: (
    integration: IntegrationSummary,
    capability: string,
    enabled: boolean,
  ) => Promise<void>;
  readonly connectionAttentionRequest?: number;
}) {
  const connected = integration.connectionState === "connected";
  const hasUnavailableEnabledSkill =
    integration.enabled &&
    integration.capabilities.some((capability) => capability.enabled && !capability.available);
  const visibleStatusMessage =
    integration.statusMessage &&
    (integration.requiresConnection ||
      integration.connectionState === "error" ||
      hasUnavailableEnabledSkill)
      ? integration.statusMessage
      : null;
  const statusIsError = integration.connectionState === "error" || hasUnavailableEnabledSkill;
  const needsConnectionAction = integrationNeedsConnectionAction(integration);
  const [expanded, setExpanded] = useState(() =>
    shouldExpandIntegrationCard({ needsConnectionAction, hasFlow: flow !== null }),
  );
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const handledAttentionRequestRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (
      shouldExpandIntegrationCard({
        needsConnectionAction,
        hasFlow: flow !== null,
        ...(connectionAttentionRequest !== undefined ? { connectionAttentionRequest } : {}),
      })
    ) {
      setExpanded(true);
    }
  }, [connectionAttentionRequest, flow, needsConnectionAction]);

  useEffect(() => {
    if (
      !shouldFocusConnectionAction({
        expanded,
        ...(connectionAttentionRequest !== undefined ? { connectionAttentionRequest } : {}),
        ...(handledAttentionRequestRef.current !== undefined
          ? { handledAttentionRequest: handledAttentionRequestRef.current }
          : {}),
      })
    ) {
      return;
    }
    handledAttentionRequestRef.current = connectionAttentionRequest;
    connectButtonRef.current?.focus();
  }, [connectionAttentionRequest, expanded]);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <article
        className="border-t border-border/60 p-5 first:border-t-0 sm:p-6"
        aria-labelledby={`${integration.id}-title`}
      >
        <div className="flex items-start gap-3">
          <CollapsibleTrigger className="group flex min-w-0 flex-1 items-start gap-4 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-muted/30 transition-colors group-hover:bg-muted/50">
              <PuzzleIcon className="size-6 text-muted-foreground" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <h3 id={`${integration.id}-title`} className="text-base font-semibold">
                {integration.name}
              </h3>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {integration.description}
              </p>
              {integration.compatibilityMessage ? (
                <p className="mt-2 text-xs text-destructive">{integration.compatibilityMessage}</p>
              ) : null}
              {visibleStatusMessage ? (
                <p
                  className={
                    statusIsError
                      ? "mt-2 text-xs text-destructive"
                      : "mt-2 text-xs text-muted-foreground"
                  }
                  role={statusIsError ? "alert" : "status"}
                >
                  {visibleStatusMessage}
                </p>
              ) : null}
            </span>
            <ChevronDownIcon
              className={`mt-1 size-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`}
              aria-hidden="true"
            />
            <span className="sr-only">
              {expanded ? "Collapse plugin details" : "Expand plugin details"}
            </span>
          </CollapsibleTrigger>
          <label className="inline-flex shrink-0 items-center gap-2 pt-0.5 text-xs font-medium">
            <Switch
              checked={integration.enabled}
              disabled={busy || (!integration.enabled && !integration.compatible)}
              aria-label={`${integration.name} enabled`}
              onCheckedChange={(checked) =>
                void onAction(checked ? "enable" : "disable", integration)
              }
            />
            Enabled
          </label>
        </div>

        <CollapsiblePanel>
          {integration.requiresConnection ? (
            <PluginDetailSection
              title="Apps"
              count={1}
              icon={<PlugIcon className="size-4 text-muted-foreground" />}
            >
              <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                    <PlugIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{integration.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {integration.accountLabel ?? "Connect the service used by this plugin."}
                    </p>
                    {needsConnectionAction ? (
                      <IntegrationConnectionActionCallout integrationName={integration.name} />
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {connected ? (
                    <>
                      {needsConnectionAction ? (
                        <Button
                          ref={connectButtonRef}
                          size="sm"
                          disabled={busy || flow !== null}
                          aria-label={integrationConnectAriaLabel(integration.name)}
                          onClick={() => void onAction("connect", integration)}
                        >
                          <PlugIcon /> Connect
                        </Button>
                      ) : null}
                      <Menu>
                        <MenuTrigger
                          render={<Button size="sm" variant="outline" disabled={busy} />}
                        >
                          <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
                          Connected
                          <ChevronDownIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => void onAction("disconnect", integration)}>
                            <UnplugIcon /> Disconnect
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </>
                  ) : integration.installed &&
                    (integration.connectionState === "error" || !integration.compatible) ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void onAction("disconnect", integration)}
                      >
                        <UnplugIcon /> Reset connection
                      </Button>
                      {integration.enabled && integration.compatible ? (
                        <Button
                          ref={connectButtonRef}
                          size="sm"
                          disabled={busy || flow !== null}
                          aria-label={integrationConnectAriaLabel(integration.name)}
                          onClick={() => void onAction("connect", integration)}
                        >
                          <PlugIcon /> Connect
                        </Button>
                      ) : null}
                    </>
                  ) : integration.installed && integration.enabled && integration.compatible ? (
                    <Button
                      ref={connectButtonRef}
                      size="sm"
                      disabled={busy || flow !== null}
                      aria-label={integrationConnectAriaLabel(integration.name)}
                      onClick={() => void onAction("connect", integration)}
                    >
                      <PlugIcon /> Connect
                    </Button>
                  ) : (
                    <Badge size="sm" variant={connectionVariant(integration)}>
                      {connectionLabel(integration)}
                    </Badge>
                  )}
                </div>
              </div>
            </PluginDetailSection>
          ) : null}

          {flow ? (
            <IntegrationAuthorizationFlow
              integrationName={integration.name}
              flow={flow}
              busy={busy}
              onApiKeySubmit={(flowId, value) => onApiKeySubmit(integration, flowId, value)}
            />
          ) : null}

          <PluginDetailSection
            title="Access"
            count={integration.capabilities.length}
            icon={<ShieldCheckIcon className="size-4 text-muted-foreground" />}
          >
            {integration.capabilities.length > 0 ? (
              <div className="divide-y divide-border/50">
                {integration.capabilities.map((capability) => {
                  const writeAbility = capabilityUsesWriteTool(integration, capability.id);
                  const stateLabel = capabilityAccessStateLabel(integration, capability);
                  return (
                    <div
                      key={capability.id}
                      className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{capability.displayName}</p>
                          <Badge size="sm" variant={capability.available ? "success" : "outline"}>
                            {stateLabel}
                          </Badge>
                          {writeAbility ? (
                            <Badge size="sm" variant="warning">
                              <LockKeyholeIcon className="size-3" aria-hidden="true" />
                              Write · confirmation required
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {capability.description}
                        </p>
                      </div>
                      <label className="inline-flex items-center justify-between gap-3 text-xs font-semibold sm:justify-end">
                        <span>Access</span>
                        <Switch
                          checked={capability.enabled}
                          disabled={
                            busy ||
                            !integration.installed ||
                            !integration.enabled ||
                            !integration.compatible
                          }
                          aria-label={`${capability.displayName} access enabled`}
                          onCheckedChange={(enabled) =>
                            void onCapabilityEnabled(integration, capability.id, enabled)
                          }
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="py-4 text-xs text-muted-foreground">
                This plugin does not request service access.
              </p>
            )}
          </PluginDetailSection>

          <PluginDetailSection
            title="Tools"
            count={integration.tools.length}
            icon={<WrenchIcon className="size-4 text-muted-foreground" />}
          >
            {integration.tools.length > 0 ? (
              <div className="divide-y divide-border/50">
                {integration.tools.map((tool) => (
                  <div key={tool.name} className="flex items-start justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <WrenchIcon className="size-3.5 text-muted-foreground" />
                        {tool.displayName}
                        {tool.effect === "write" ? (
                          <LockKeyholeIcon
                            className="size-3.5 text-amber-600"
                            aria-label="Write operation; confirmation required"
                          />
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{tool.description}</p>
                    </div>
                    <Badge size="sm" variant={tool.available ? "success" : "outline"}>
                      {tool.available ? "Available" : "Inactive"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-4 text-xs text-muted-foreground">
                This plugin does not add backend tools.
              </p>
            )}
          </PluginDetailSection>

          <PluginDetailSection
            title="Skills"
            count={integration.skills.length}
            icon={<SparklesIcon className="size-4 text-muted-foreground" />}
          >
            {integration.skills.length > 0 ? (
              <div className="divide-y divide-border/50">
                {integration.skills.map((skill) => (
                  <div key={skill.name} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        <SparklesIcon className="size-3.5 text-muted-foreground" />
                        {skill.name}
                        {skill.available ? (
                          <CheckCircle2Icon
                            className="size-3.5 text-emerald-600"
                            aria-label="Available"
                          />
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{skill.description}</p>
                    </div>
                    <Badge size="sm" variant={skill.available ? "success" : "outline"}>
                      {skill.available ? "Available" : "Inactive"}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-4 text-xs text-muted-foreground">
                This plugin does not add Codex skills.
              </p>
            )}
          </PluginDetailSection>

          <PluginDetailSection
            title="Information"
            icon={<InfoIcon className="size-4 text-muted-foreground" />}
          >
            <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 gap-y-3 py-4 text-sm">
              <dt className="text-muted-foreground">Access model</dt>
              <dd>Capability controlled</dd>
              <dt className="text-muted-foreground">Version</dt>
              <dd>{integration.version}</dd>
              <dt className="text-muted-foreground">Package API</dt>
              <dd>{integration.apiVersion}</dd>
              <dt className="text-muted-foreground">Connection</dt>
              <dd>{integration.requiresConnection ? "Bundled service" : "None required"}</dd>
            </dl>
          </PluginDetailSection>
        </CollapsiblePanel>
      </article>
    </Collapsible>
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
  const capabilityEnabledCommand = useAtomCommand(
    serverEnvironment.setIntegrationCapabilityEnabled,
    {
      reportFailure: false,
    },
  );
  const connectCommand = useAtomCommand(serverEnvironment.connectIntegration, {
    reportFailure: false,
  });
  const pollCommand = useAtomCommand(serverEnvironment.pollIntegration, { reportFailure: false });
  const disconnectCommand = useAtomCommand(serverEnvironment.disconnectIntegration, {
    reportFailure: false,
  });
  const [data, setData] = useState<IntegrationsListResult>({ integrations: [] });
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flows, setFlows] = useState<ReadonlyMap<string, ActiveIntegrationFlow>>(() => new Map());
  const [connectionAttentionState, setConnectionAttentionState] =
    useState<ConnectionAttentionState>({ attention: null, announcement: "" });
  const connectionAttention = connectionAttentionState.attention;
  const connectionAnnouncement = connectionAttentionState.announcement;
  const connectionAttentionSequenceRef = useRef(0);
  const activeFlowIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    setData({ integrations: [] });
    setFlows(new Map());
    activeFlowIdsRef.current = new Map();
    setBusyIds(new Set());
    setErrors({});
    setConnectionAttentionState({ attention: null, announcement: "" });
    connectionAttentionSequenceRef.current = 0;
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
      if (!integrationFlowIsActive(flow, Date.now())) {
        if (activeFlowIdsRef.current.get(id) === flow.flowId) {
          activeFlowIdsRef.current.delete(id);
          setErrors((current) => ({
            ...current,
            [id]: "Plugin sign-in expired. Start again.",
          }));
          setFlows((current) => updateIntegrationFlowIfCurrent(current, id, flow.flowId, null));
        }
        return;
      }
      try {
        const result = unwrap(
          await pollCommand({
            environmentId: targetEnvironmentId,
            input: { id, flowId: flow.flowId },
          }),
        );
        if (
          cancelled() ||
          environmentIdRef.current !== targetEnvironmentId ||
          activeFlowIdsRef.current.get(id) !== flow.flowId
        )
          return;
        setData((current) => ({
          integrations: current.integrations.map((item) =>
            item.id === id ? result.integration : item,
          ),
        }));
        if (result.integration.connectionState === "connected") {
          setConnectionAttentionState((current) => clearOwnedConnectionAttention(current, id));
        }
        setErrors((current) => {
          const { [id]: _, ...rest } = current;
          return rest;
        });
        if (result.state !== "pending") {
          activeFlowIdsRef.current.delete(id);
          if (result.state === "failed" || result.state === "expired") {
            setErrors((current) => ({
              ...current,
              [id]: result.message ?? "Plugin sign-in did not complete. Start again.",
            }));
          }
          setFlows((current) => updateIntegrationFlowIfCurrent(current, id, flow.flowId, null));
        } else if (integrationFlowIsActive(flow, Date.now())) {
          setFlows((current) =>
            updateIntegrationFlowIfCurrent(
              current,
              id,
              flow.flowId,
              scheduleIntegrationFlow(withIntegrationPollDelay(flow, result.retryAfterSeconds)),
            ),
          );
        } else {
          activeFlowIdsRef.current.delete(id);
          setErrors((current) => ({
            ...current,
            [id]: "Plugin sign-in expired. Start again.",
          }));
          setFlows((current) => updateIntegrationFlowIfCurrent(current, id, flow.flowId, null));
        }
      } catch (cause) {
        if (
          cancelled() ||
          environmentIdRef.current !== targetEnvironmentId ||
          activeFlowIdsRef.current.get(id) !== flow.flowId
        )
          return;
        setErrors((current) => ({ ...current, [id]: errorMessage(cause) }));
        if (integrationFlowIsActive(flow, Date.now())) {
          setFlows((current) =>
            updateIntegrationFlowIfCurrent(current, id, flow.flowId, scheduleIntegrationFlow(flow)),
          );
        } else {
          activeFlowIdsRef.current.delete(id);
          setFlows((current) => updateIntegrationFlowIfCurrent(current, id, flow.flowId, null));
        }
      }
    },
    [environmentId, pollCommand],
  );

  const action = useCallback(
    async (
      kind: "enable" | "disable" | "connect" | "disconnect",
      integration: IntegrationSummary,
    ) => {
      if (!environmentId) return;
      const targetEnvironmentId = environmentId;
      setBusyIds((current) => new Set(current).add(integration.id));
      setErrors((current) => {
        const { [integration.id]: _, ...rest } = current;
        return rest;
      });
      if (kind === "disable" || kind === "disconnect") {
        activeFlowIdsRef.current.delete(integration.id);
        setFlows((current) => {
          const next = new Map(current);
          next.delete(integration.id);
          return next;
        });
        setConnectionAttentionState((current) =>
          clearOwnedConnectionAttention(current, integration.id),
        );
      }
      try {
        if (kind === "connect") {
          const flow = unwrap(
            await connectCommand({
              environmentId: targetEnvironmentId,
              input: { id: integration.id },
            }),
          );
          if (environmentIdRef.current !== targetEnvironmentId) return;
          activeFlowIdsRef.current.set(integration.id, flow.flowId);
          if (flow.kind === "connected") {
            activeFlowIdsRef.current.delete(integration.id);
            setFlows((current) => {
              const next = new Map(current);
              next.delete(integration.id);
              return next;
            });
            setConnectionAttentionState((current) =>
              clearOwnedConnectionAttention(current, integration.id),
            );
            await load();
          } else {
            setFlows((current) =>
              new Map(current).set(
                integration.id,
                flow.kind === "device_code" ? scheduleIntegrationFlow(flow) : flow,
              ),
            );
          }
        } else {
          const command =
            kind === "enable" && !integration.installed
              ? installCommand({
                  environmentId: targetEnvironmentId,
                  input: { id: integration.id },
                })
              : kind === "enable" || kind === "disable"
                ? enabledCommand({
                    environmentId: targetEnvironmentId,
                    input: { id: integration.id, enabled: kind === "enable" },
                  })
                : disconnectCommand({
                    environmentId: targetEnvironmentId,
                    input: { id: integration.id },
                  });
          const result = unwrap(await command);
          if (environmentIdRef.current !== targetEnvironmentId) return;
          setData(result);
          // First-time installation is also represented by the "enable" action kind above.
          if (kind === "enable") {
            const updated = result.integrations.find(({ id }) => id === integration.id);
            if (updated && integrationNeedsConnectionAction(updated)) {
              connectionAttentionSequenceRef.current += 1;
              setConnectionAttentionState({
                attention: {
                  id: integration.id,
                  request: connectionAttentionSequenceRef.current,
                },
                announcement: `Action required: Connect ${updated.name}`,
              });
            } else {
              setConnectionAttentionState((current) =>
                clearOwnedConnectionAttention(current, integration.id),
              );
            }
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
    [connectCommand, disconnectCommand, enabledCommand, environmentId, installCommand, load],
  );

  const submitApiKey = useCallback(
    async (integration: IntegrationSummary, flowId: string, value: string) => {
      if (!environmentId) return;
      const targetEnvironmentId = environmentId;
      setBusyIds((current) => new Set(current).add(integration.id));
      setErrors((current) => {
        const { [integration.id]: _, ...rest } = current;
        return rest;
      });
      try {
        const result = unwrap(
          await connectCommand({
            environmentId: targetEnvironmentId,
            input: {
              id: integration.id,
              submission: { kind: "api_key", flowId, value },
            },
          }),
        );
        if (environmentIdRef.current !== targetEnvironmentId) return;
        if (result.kind !== "connected" || result.flowId !== flowId) {
          throw new Error("The plugin did not confirm the API-key connection.");
        }
        activeFlowIdsRef.current.delete(integration.id);
        setFlows((current) => {
          if (current.get(integration.id)?.flowId !== flowId) return current;
          const next = new Map(current);
          next.delete(integration.id);
          return next;
        });
        setConnectionAttentionState((current) =>
          clearOwnedConnectionAttention(current, integration.id),
        );
        await load();
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
    [connectCommand, environmentId, load],
  );

  const setCapabilityEnabled = useCallback(
    async (integration: IntegrationSummary, capability: string, enabled: boolean) => {
      if (!environmentId) return;
      const targetEnvironmentId = environmentId;
      setBusyIds((current) => new Set(current).add(integration.id));
      setErrors((current) => {
        const { [integration.id]: _, ...rest } = current;
        return rest;
      });
      try {
        const result = unwrap(
          await capabilityEnabledCommand({
            environmentId: targetEnvironmentId,
            input: { id: integration.id, capability, enabled },
          }),
        );
        if (environmentIdRef.current !== targetEnvironmentId) return;
        setData(result);
        const updated = result.integrations.find(({ id }) => id === integration.id);
        const updatedCapability = updated?.capabilities.find(({ id }) => id === capability);
        setConnectionAttentionState((current) =>
          reconcileConnectionAttentionForIntegration(current, integration.id, updated),
        );
        if (
          enabled &&
          updated?.requiresConnection &&
          updatedCapability?.enabled &&
          !updatedCapability.granted
        ) {
          const flow = unwrap(
            await connectCommand({
              environmentId: targetEnvironmentId,
              input: { id: integration.id },
            }),
          );
          if (environmentIdRef.current !== targetEnvironmentId) return;
          activeFlowIdsRef.current.set(integration.id, flow.flowId);
          if (flow.kind === "connected") {
            activeFlowIdsRef.current.delete(integration.id);
            setConnectionAttentionState((current) =>
              clearOwnedConnectionAttention(current, integration.id),
            );
            await load();
          } else {
            setFlows((current) =>
              new Map(current).set(
                integration.id,
                flow.kind === "device_code" ? scheduleIntegrationFlow(flow) : flow,
              ),
            );
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
    [capabilityEnabledCommand, connectCommand, environmentId, load],
  );

  return (
    <SettingsPageContainer>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {connectionAnnouncement}
      </p>
      {[...flows].map(([id, flow]) =>
        flow.kind === "device_code" ? (
          <IntegrationFlowPoller key={`${id}:${flow.flowId}`} id={id} flow={flow} poll={pollFlow} />
        ) : null,
      )}
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Plugins</h1>
        <p className="text-xs text-muted-foreground">
          Turn plugins on or off, then choose the abilities they can use under Access.
          Connected-service credentials remain on this server. Changes reconcile before the next
          idle turn; disabling access revokes its tools immediately.
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
        title="Included plugins"
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
        {data.integrations.length ? (
          data.integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              busy={busyIds.has(integration.id)}
              flow={flows.get(integration.id) ?? null}
              onAction={action}
              onApiKeySubmit={submitApiKey}
              onCapabilityEnabled={setCapabilityEnabled}
              {...(connectionAttention?.id === integration.id
                ? { connectionAttentionRequest: connectionAttention.request }
                : {})}
            />
          ))
        ) : (
          <p className="p-6 text-center text-xs text-muted-foreground">
            No plugins are included in this Harness build.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
