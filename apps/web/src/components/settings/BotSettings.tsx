import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  DotApiError,
  DotClient,
  readDotSession,
  saveDotSession,
  type DotSession,
  type DotState,
} from "../dot/dotClient";
import { useBotServiceUrl } from "../dot/botService";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { describeTaskComputer, describeThisComputer, isTaskComputer } from "./BotSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * TritonAI Bot settings. Every signed-in Harness can chat with the bot; this page
 * chooses the one computer that runs approved Harness tasks and whether reviews
 * warn when it is offline. The bot session comes from the TritonAI Bot page.
 */
export function BotSettings() {
  const serviceUrl = useBotServiceUrl();
  return <BotSettingsForService key={serviceUrl ?? "off"} serviceUrl={serviceUrl} />;
}

function BotSettingsForService({ serviceUrl }: { serviceUrl: string | null }) {
  const client = useMemo(() => (serviceUrl ? new DotClient(serviceUrl) : null), [serviceUrl]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const [session, setSession] = useState<DotSession | null>(() =>
    serviceUrl ? readDotSession(sessionStorage, serviceUrl) : null,
  );
  const [state, setState] = useState<DotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const { data: local, refresh: refreshLocal } = useEnvironmentQuery(
    environmentId ? serverEnvironment.botTaskComputer({ environmentId, input: {} }) : null,
  );
  const allowHere = useAtomCommand(serverEnvironment.allowBotTaskComputer, {
    reportFailure: false,
  });
  const stopHere = useAtomCommand(serverEnvironment.stopBotTaskComputer, { reportFailure: false });
  const setTaskProject = useAtomCommand(serverEnvironment.setBotTaskProject, {
    reportFailure: false,
  });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectId = chosenProjectId ?? local?.projectId ?? projects[0]?.id ?? null;
  const localForService =
    local?.apiUrl === serviceUrl && local.userId === state?.user.userId ? local : null;
  const thisComputer = isTaskComputer(state?.taskComputer, localForService);
  const otherComputer = state?.taskComputer && !thisComputer ? state.taskComputer.deviceName : null;

  const isCurrentSession = useCallback(
    (token: string) =>
      mounted.current &&
      Boolean(serviceUrl && readDotSession(sessionStorage, serviceUrl)?.ownerToken === token),
    [serviceUrl],
  );
  const loadState = useCallback(async () => {
    if (!serviceUrl || !client) return;
    const current = readDotSession(sessionStorage, serviceUrl);
    if (current?.ownerToken !== session?.ownerToken) {
      if (mounted.current) {
        setSession(current);
        setState(null);
        setError(null);
      }
      return;
    }
    if (!session) return;
    try {
      const next = await client.state(session);
      if (isCurrentSession(session.ownerToken)) setState(next);
    } catch (cause) {
      if (!isCurrentSession(session.ownerToken)) return;
      if (cause instanceof DotApiError && cause.status === 401) {
        saveDotSession(sessionStorage, serviceUrl, null);
        setSession(null);
        setState(null);
      }
      setError(cause instanceof Error ? cause.message : "Could not reach TritonAI Bot.");
    }
  }, [client, session, serviceUrl, isCurrentSession]);

  useEffect(() => {
    void loadState();
    const timer = setInterval(() => void loadState(), 30_000);
    return () => clearInterval(timer);
  }, [loadState]);

  const allow = async () => {
    if (!session || !serviceUrl || !environmentId || !projectId) return;
    setBusy(true);
    setError(null);
    const result = await allowHere({
      environmentId,
      input: { apiUrl: serviceUrl, ownerToken: session.ownerToken, projectId },
    });
    if (!mounted.current) return;
    setBusy(false);
    if (session && !isCurrentSession(session.ownerToken)) return;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not allow this computer."));
    }
    refreshLocal();
    await loadState();
  };

  const stop = async () => {
    if (!environmentId) return;
    setBusy(true);
    setError(null);
    const result = await stopHere({
      environmentId,
      input: {
        ownerToken: localForService ? (session?.ownerToken ?? null) : null,
        apiUrl: serviceUrl,
      },
    });
    if (!mounted.current) return;
    setBusy(false);
    if (session && !isCurrentSession(session.ownerToken)) return;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not stop running tasks here."));
    }
    refreshLocal();
    await loadState();
  };

  const chooseProject = async (value: string) => {
    setChosenProjectId(value);
    if (
      !environmentId ||
      !localForService ||
      localForService.state === "off" ||
      localForService.state === "replaced"
    )
      return;
    const result = await setTaskProject({ environmentId, input: { projectId: value } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not change the project."));
    }
    refreshLocal();
  };

  const setWarning = async (enabled: boolean) => {
    if (!session || !client) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await client.updateSettings(session, {
        warnWhenTaskComputerOffline: enabled,
      });
      if (!isCurrentSession(session.ownerToken)) return;
      setState((current) =>
        current ? { ...current, user: { ...current.user, ...user } } : current,
      );
    } catch (cause) {
      if (!isCurrentSession(session.ownerToken)) return;
      setError(cause instanceof Error ? cause.message : "Could not save the setting.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const projectTitle = projects.find((project) => project.id === projectId)?.title;

  return (
    <SettingsPageContainer>
      {!serviceUrl ? (
        <p className="text-sm text-muted-foreground">
          Set a TritonAI Bot service address in Settings → Connections to manage your bot.
        </p>
      ) : null}
      <SettingsSection id="tritonai-bot-account" title="Account">
        <SettingsRow
          title="Campus account"
          description={
            session
              ? `Signed in as ${session.email}.`
              : "Sign in on the TritonAI Bot page to manage these settings."
          }
          control={
            session ? undefined : (
              <Button size="xs" onClick={() => void navigate({ to: "/dot" })}>
                Open TritonAI Bot
              </Button>
            )
          }
        />
        {state ? (
          <SettingsRow
            title="Bot status"
            description={
              state.user.paused
                ? "Paused. Messages, approvals and new tasks wait until you resume it."
                : "Active. Every signed-in Harness can chat with it and review approvals."
            }
            control={
              <Badge size="sm" variant={state.user.paused ? "warning" : "success"}>
                {state.user.paused ? "Paused" : "Active"}
              </Badge>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection id="tritonai-bot-task-computer" title="Task computer">
        <SettingsRow
          title="Runs approved tasks"
          description={describeTaskComputer(state?.taskComputer, thisComputer)}
          control={
            state?.taskComputer ? (
              <Badge size="sm" variant={state.taskComputer.online ? "success" : "warning"}>
                {state.taskComputer.online ? "Online" : "Offline"}
              </Badge>
            ) : undefined
          }
        />
        <SettingsRow
          title={local ? `This computer · ${local.deviceName}` : "This computer"}
          description={
            otherComputer && !thisComputer
              ? `${describeThisComputer(localForService)} Allow moves task running here from ${otherComputer}.`
              : local && !localForService && local.state !== "off"
                ? "This Harness is paired with a different Bot service or account. Choose Allow to pair it with the signed-in account."
                : describeThisComputer(local ?? null)
          }
          status={error ? <span className="text-destructive">{error}</span> : undefined}
          control={
            <div className="flex gap-2">
              {local && local.state !== "off" ? (
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void stop()}>
                  Stop running tasks here
                </Button>
              ) : null}
              {!thisComputer ? (
                <Button
                  size="xs"
                  disabled={busy || !serviceUrl || !session || !environmentId || !projectId}
                  onClick={() => void allow()}
                >
                  Allow
                </Button>
              ) : null}
            </div>
          }
        />
        <SettingsRow
          title="Project for tasks"
          description={
            projects.length
              ? "Task threads open in this project and use its model and permission settings."
              : "Add a project first. Task threads open in a project and use its settings."
          }
          control={
            projects.length ? (
              <Select
                value={projectId ?? ""}
                onValueChange={(value) => {
                  if (typeof value === "string" && value) void chooseProject(value);
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Project for tasks">
                  <SelectValue>{projectTitle ?? "Choose a project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : undefined
          }
        />
      </SettingsSection>

      <SettingsSection id="tritonai-bot-approvals" title="Approvals">
        <SettingsRow
          title="Warn when the task computer is offline"
          description="Harness assignment reviews here and in Teams say when approved work would wait. Approval replies always say where the work went."
          control={
            <Switch
              checked={state?.user.warnWhenTaskComputerOffline !== false}
              disabled={busy || !session || !state}
              onCheckedChange={(checked) => void setWarning(Boolean(checked))}
              aria-label="Warn when the task computer is offline"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
