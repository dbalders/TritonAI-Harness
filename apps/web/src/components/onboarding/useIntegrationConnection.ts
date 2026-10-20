import type {
  EnvironmentId,
  IntegrationConnectResult,
  IntegrationSummary,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  integrationConnectResultNeedsPolling,
  integrationFlowCanRetryAfterPollError,
  integrationFlowIsActive,
  scheduleIntegrationFlow,
  withIntegrationPollDelay,
  type ScheduledIntegrationFlow,
} from "../settings/integrationPolling";
import { integrationNeedsConnectionAction } from "../settings/PluginsSettings";

/**
 * One plugin's connection for the guided tour. It turns the plugin on when needed,
 * starts sign-in, opens the provider's page, and follows the sign-in until it finishes.
 * Settings > Plugins remains the full view of every plugin and capability.
 */
export type IntegrationConnectionStatus =
  | "loading"
  | "unavailable"
  | "ready"
  | "starting"
  | "waiting"
  | "connected"
  | "failed";

export interface IntegrationConnection {
  readonly status: IntegrationConnectionStatus;
  readonly integration: IntegrationSummary | null;
  /** The sign-in in progress: a device code to enter, or a page to finish on. */
  readonly flow: IntegrationConnectResult | null;
  readonly error: string | null;
  readonly connect: () => Promise<void>;
}

interface ConnectionSession {
  readonly key: string;
  /** Which sign-in attempt this is; see `attempts` in the hook. */
  readonly attempt: number;
  readonly starting: boolean;
  readonly scheduled: ScheduledIntegrationFlow | null;
  readonly error: string | null;
}

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Something went wrong. Try again.";
}

export function integrationSignInUrl(flow: IntegrationConnectResult | null): string | null {
  if (!flow) return null;
  if (flow.kind === "device_code") return flow.verificationUriComplete ?? flow.verificationUri;
  if (flow.kind === "authorization_url") return flow.authorizationUrl;
  return null;
}

/** Signed in is not enough: a disabled plugin, or one missing an approval, gives no tools. */
export function integrationIsUsable(integration: IntegrationSummary | null): boolean {
  return (
    integration !== null &&
    integration.installed &&
    integration.enabled &&
    integration.connectionState === "connected" &&
    !integrationNeedsConnectionAction(integration)
  );
}

export function connectionStatusFor(input: {
  readonly loading: boolean;
  readonly integration: IntegrationSummary | null;
  readonly starting: boolean;
  readonly flow: IntegrationConnectResult | null;
  readonly error: string | null;
}): IntegrationConnectionStatus {
  if (integrationIsUsable(input.integration)) return "connected";
  if (input.starting) return "starting";
  if (input.flow && integrationConnectResultNeedsPolling(input.flow)) return "waiting";
  if (input.loading) return "loading";
  if (!input.integration) return "unavailable";
  if (input.error) return "failed";
  return "ready";
}

function openSignIn(url: string | null) {
  if (!url) return;
  void ensureLocalApi()
    .shell.openExternal(url)
    .catch(() => {
      // The sign-in link stays on screen, so the person can open it themselves.
    });
}

export function useIntegrationConnection(
  integrationId: string,
  environmentId: EnvironmentId | null,
): IntegrationConnection {
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

  // Everything is stored with the environment and plugin it belongs to, so switching
  // either shows that connection's own state, and coming back resumes a sign-in.
  const key = environmentId === null ? null : `${environmentId}:${integrationId}`;
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly integration: IntegrationSummary | null;
  } | null>(null);
  const [session, setSession] = useState<ConnectionSession | null>(null);
  // Results that arrive after unmounting or switching environments are ignored, so a
  // late response can never open a sign-in page or poll the wrong server.
  const generation = useRef(0);

  const integration = loaded !== null && loaded.key === key ? loaded.integration : null;
  const loading = key !== null && loaded?.key !== key;
  const current = session !== null && session.key === key ? session : null;
  const scheduled = current?.scheduled ?? null;

  useEffect(() => {
    const owner = ++generation.current;
    if (!environmentId || key === null) return;
    void (async () => {
      let found: IntegrationSummary | null = null;
      try {
        const result = unwrap(await listCommand({ environmentId, input: {} }));
        found = result.integrations.find((item) => item.id === integrationId) ?? null;
      } catch {
        found = null;
      }
      if (generation.current === owner) setLoaded({ key, integration: found });
    })();
    return () => {
      if (generation.current === owner) generation.current++;
    };
  }, [environmentId, integrationId, key, listCommand]);

  // The latest sign-in attempt for each environment. "Start over" begins a new attempt,
  // so a late answer for an earlier one changes neither the sign-in nor the plugin.
  const attempts = useRef(new Map<string, number>());
  const nextAttempt = useRef(0);
  const attempt = current?.attempt ?? null;

  // Follow the sign-in until the provider reports it finished, failed, or expired.
  useEffect(() => {
    if (!environmentId || key === null || !scheduled || attempt === null) return;
    const owner = generation.current;
    const live = () => generation.current === owner && attempts.current.get(key) === attempt;
    const finish = (error: string | null) =>
      setSession({ key, attempt, starting: false, scheduled: null, error });
    const timer = window.setTimeout(
      async () => {
        if (!live()) return;
        if (!integrationFlowIsActive(scheduled, Date.now())) {
          finish("The sign-in expired. Try again.");
          return;
        }
        try {
          const result = unwrap(
            await pollCommand({
              environmentId,
              input: { id: integrationId, flowId: scheduled.flowId },
            }),
          );
          if (!live()) return;
          setLoaded({ key, integration: result.integration });
          if (result.state === "pending") {
            setSession({
              key,
              attempt,
              starting: false,
              error: null,
              scheduled: scheduleIntegrationFlow(
                withIntegrationPollDelay(scheduled, result.retryAfterSeconds),
              ),
            });
            return;
          }
          finish(
            result.state === "connected"
              ? null
              : (result.message ?? "The sign-in did not finish. Try again."),
          );
        } catch (cause) {
          if (!live()) return;
          if (integrationFlowCanRetryAfterPollError(scheduled, Date.now())) {
            setSession({
              key,
              attempt,
              starting: false,
              error: null,
              scheduled: scheduleIntegrationFlow(scheduled),
            });
          } else {
            finish(errorMessage(cause));
          }
        }
      },
      Math.max(0, scheduled.nextPollAtMilliseconds - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [attempt, environmentId, integrationId, key, pollCommand, scheduled]);

  const connect = useCallback(async () => {
    if (!environmentId || key === null || !integration) return;
    const owner = generation.current;
    const attempt = ++nextAttempt.current;
    attempts.current.set(key, attempt);
    const live = () => generation.current === owner && attempts.current.get(key) === attempt;
    const settle = (next: Pick<ConnectionSession, "scheduled" | "error">) => {
      if (live()) {
        setSession({ key, attempt, starting: false, ...next });
        return;
      }
      // An attempt abandoned by switching environments must not stay "starting".
      setSession((previous) =>
        previous?.key === key && previous.attempt === attempt ? null : previous,
      );
    };
    setSession({ key, attempt, starting: true, scheduled: null, error: null });
    try {
      let latest = integration;
      if (!latest.installed || !latest.enabled) {
        const result = unwrap(
          await (latest.installed
            ? enabledCommand({ environmentId, input: { id: integrationId, enabled: true } })
            : installCommand({ environmentId, input: { id: integrationId } })),
        );
        if (live()) {
          latest = result.integrations.find((item) => item.id === integrationId) ?? latest;
          setLoaded({ key, integration: latest });
        }
      }
      if (!live() || integrationIsUsable(latest)) {
        settle({ scheduled: null, error: null });
        return;
      }
      const started = unwrap(await connectCommand({ environmentId, input: { id: integrationId } }));
      if (!live()) {
        settle({ scheduled: null, error: null });
        return;
      }
      if (started.kind === "connected") {
        const refreshed = unwrap(await listCommand({ environmentId, input: {} }));
        if (live()) {
          setLoaded({
            key,
            integration: refreshed.integrations.find((item) => item.id === integrationId) ?? null,
          });
        }
        settle({ scheduled: null, error: null });
        return;
      }
      if (!integrationConnectResultNeedsPolling(started)) {
        settle({ scheduled: null, error: "Finish connecting this account in Settings → Plugins." });
        return;
      }
      settle({ scheduled: scheduleIntegrationFlow(started), error: null });
      // Take them straight to the provider's page instead of asking them to find it.
      if (live()) openSignIn(integrationSignInUrl(started));
    } catch (cause) {
      settle({ scheduled: null, error: errorMessage(cause) });
    }
  }, [
    connectCommand,
    enabledCommand,
    environmentId,
    installCommand,
    integration,
    integrationId,
    key,
    listCommand,
  ]);

  const flow = scheduled;
  const starting = current?.starting ?? false;
  const error = current?.error ?? null;
  return {
    status: connectionStatusFor({ loading, integration, starting, flow, error }),
    integration,
    flow,
    error,
    connect,
  };
}
