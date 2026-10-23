import { useStableCallback } from "../../hooks/useStableCallback";
import { useAtomValue } from "@effect/atom-react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

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
import { useScratchProject } from "../../hooks/useScratchProject";
import {
  useClientSettings,
  usePrimarySettings,
  usePrimarySettingsAvailable,
  updateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { BotMicrosoftConnection } from "../dot/BotDiscoveryPanels";
import { useBotServiceUrl } from "../dot/botService";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  describeTaskComputer,
  describeThisComputer,
  describeThisComputerBesideAnother,
  isTaskComputer,
} from "./BotSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** Picker value for "No project": tasks then work in their own folders. */
const NO_PROJECT = "no-project";

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
  const [client] = useState(() => (serviceUrl ? new DotClient(serviceUrl) : null));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const canControlTasks = useAtomValue(
    serverEnvironment.allowBotTaskComputer.permissionAtom(environmentId),
  );
  const [session, setSession] = useState<DotSession | null>(() =>
    serviceUrl ? readDotSession(sessionStorage, serviceUrl) : null,
  );
  const [state, setState] = useState<DotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const diagnostics = useClientSettings((settings) => settings.tritonAiBotDiagnostics);
  const updateSettings = updateClientSettings;
  const maxParallel = usePrimarySettings((settings) => settings.botTaskMaxParallel);
  const serverSettingsAvailable = usePrimarySettingsAvailable();
  const updateServerSettings = useUpdatePrimarySettings();
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const changingProject = useRef(false);
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
  const { scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const scratchRoot = scratchWorkspaceRootFor(environmentId);
  const environmentProjects = useProjects().filter(
    (project) => project.environmentId === environmentId,
  );
  const scratchProject = environmentProjects.find((project) =>
    isScratchProject(project, scratchRoot),
  );
  const projects = environmentProjects.filter((project) => project !== scratchProject);
  const savedProjectId =
    local?.projectId && local.projectId === scratchProject?.id ? NO_PROJECT : local?.projectId;
  // A new task computer defaults to No project, where each task gets its own folder.
  const projectId =
    chosenProjectId ??
    savedProjectId ??
    (scratchRoot !== null ? NO_PROJECT : (projects[0]?.id ?? null));
  const localForService =
    local?.apiUrl === serviceUrl && local.userId === state?.user.userId ? local : null;
  const thisComputer = isTaskComputer(state?.taskComputer, localForService);
  const otherComputer = state?.taskComputer && !thisComputer ? state.taskComputer.deviceName : null;
  const projectSelectionReady = Boolean(
    canControlTasks &&
    local &&
    (local.state === "off" || local.state === "replaced" || (state && session)),
  );

  if (
    chosenProjectId &&
    localForService &&
    localForService.state !== "off" &&
    localForService.state !== "replaced"
  ) {
    // Drafts are only for Allow. Active pairings always follow the authoritative query.
    setChosenProjectId(null);
  }

  const isCurrentSession = useStableCallback(
    (token: string) =>
      mounted.current &&
      Boolean(serviceUrl && readDotSession(sessionStorage, serviceUrl)?.ownerToken === token),
  );
  const sessionOwnerToken = session?.ownerToken;
  const loadState = useStableCallback(async (ownerToken = sessionOwnerToken) => {
    if (ownerToken !== session?.ownerToken) return;
    if (!serviceUrl || !client) return;
    const current = readDotSession(sessionStorage, serviceUrl);
    if (current?.ownerToken !== session?.ownerToken) {
      if (mounted.current) {
        setSession(current);
        setState(null);
        setError(null);
        setChosenProjectId(null);
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
        setChosenProjectId(null);
      }
      setError(cause instanceof Error ? cause.message : "Could not reach TritonAI Bot.");
    }
  });

  useEffect(() => {
    void loadState(session?.ownerToken);
    const timer = setInterval(() => void loadState(session?.ownerToken), 30_000);
    return () => clearInterval(timer);
  }, [loadState, session?.ownerToken]);

  /** "No project" becomes the environment's Scratch project, created on first use. */
  const resolveProjectId = async (value: string) => {
    if (value !== NO_PROJECT) return value;
    if (!environmentId) return null;
    return (await openScratchProject(environmentId))?.id ?? null;
  };

  const allow = async () => {
    if (!session || !serviceUrl || !environmentId || !projectId) return;
    setBusy(true);
    setError(null);
    const current = await (async () => {
      const resolvedProjectId = await resolveProjectId(projectId);
      // openScratchProject already reported a failed create. A sign-out or
      // account switch while it ran must not pair with the replaced session.
      if (!resolvedProjectId || !isCurrentSession(session.ownerToken)) return;
      const result = await allowHere({
        environmentId,
        input: { apiUrl: serviceUrl, ownerToken: session.ownerToken, projectId: resolvedProjectId },
      });
      if (!isCurrentSession(session.ownerToken)) return;
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(failureMessage(result, "Could not allow this computer."));
      }
      return true;
    })().finally(() => {
      if (mounted.current) setBusy(false);
    });
    if (!current) return;
    refreshLocal();
    await loadState();
  };

  const stop = async () => {
    if (!environmentId) return;
    setBusy(true);
    setError(null);
    await (async () => {
      try {
        const result = await stopHere({
          environmentId,
          input: {
            ownerToken: localForService ? (session?.ownerToken ?? null) : null,
            apiUrl: serviceUrl,
          },
        });
        if (!mounted.current || (session && !isCurrentSession(session.ownerToken))) return;
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          setError(failureMessage(result, "Could not stop running tasks here."));
        }
        refreshLocal();
        await loadState();
      } catch (cause) {
        if (!mounted.current || (session && !isCurrentSession(session.ownerToken))) return;
        setError(cause instanceof Error ? cause.message : "Could not stop running tasks here.");
      }
    })().finally(() => {
      if (mounted.current) setBusy(false);
    });
  };

  const chooseProject = async (value: string) => {
    if (
      busy ||
      changingProject.current ||
      !projectSelectionReady ||
      (session && !isCurrentSession(session.ownerToken))
    )
      return;
    if (
      !environmentId ||
      !localForService ||
      localForService.state === "off" ||
      localForService.state === "replaced"
    ) {
      setChosenProjectId(value);
      return;
    }
    changingProject.current = true;
    setBusy(true);
    setError(null);
    await (async () => {
      const resolvedProjectId = await resolveProjectId(value);
      if (!mounted.current || (session && !isCurrentSession(session.ownerToken))) return;
      if (!resolvedProjectId) return;
      const result = await setTaskProject({
        environmentId,
        input: { projectId: resolvedProjectId },
      });
      if (!mounted.current || (session && !isCurrentSession(session.ownerToken))) return;
      setChosenProjectId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(failureMessage(result, "Could not change the project."));
      }
      refreshLocal();
    })().finally(() => {
      changingProject.current = false;
      if (mounted.current) setBusy(false);
    });
  };

  const setWarning = async (enabled: boolean) => {
    if (!session || !client) return;
    setBusy(true);
    setError(null);
    await (async () => {
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
      }
    })().finally(() => {
      if (mounted.current) setBusy(false);
    });
  };

  const projectTitle =
    projectId === NO_PROJECT
      ? "No project"
      : projects.find((project) => project.id === projectId)?.title;
  const hasProjectChoices = scratchRoot !== null || projects.length > 0;

  return (
    <SettingsPageContainer>
      {!serviceUrl ? (
        <p className="text-sm text-muted-foreground">
          Enable TritonAI Bot in Settings → General → Experimental to manage your personal bot.
        </p>
      ) : null}
      <SettingsSection id="tritonai-bot-account" title="Account">
        {session && serviceUrl && state ? (
          <BotMicrosoftConnection
            microsoft={state.microsoft}
            connectionsUrl={`${serviceUrl}/connections`}
          />
        ) : null}
        <SettingsRow
          title="Campus account"
          description={
            session
              ? `Signed in as ${session.email}.`
              : "Sign in on the TritonAI Bot page to manage these settings."
          }
          control={
            session ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const current = session;
                  if (serviceUrl) saveDotSession(sessionStorage, serviceUrl, null);
                  setSession(null);
                  setState(null);
                  void client?.signOut(current).catch(() => undefined);
                }}
              >
                Sign out
              </Button>
            ) : (
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
        {serviceUrl && session && state?.microsoft?.available !== false ? (
          <SettingsRow
            title="Microsoft connections"
            description="Choose which Outlook, calendar, OneDrive and To Do access the bot may use, or reconnect it."
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void ensureLocalApi()
                    .shell.openExternal(`${serviceUrl}/connections`)
                    .catch((cause: unknown) =>
                      setError(cause instanceof Error ? cause.message : "Could not open the page."),
                    )
                }
              >
                Manage
              </Button>
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
            local && state && !localForService && local.state !== "off"
              ? "This Harness is paired with a different Bot service or account. Choose Allow to pair it with the signed-in account."
              : otherComputer && !thisComputer
                ? describeThisComputerBesideAnother(local ?? null, otherComputer)
                : describeThisComputer(local ?? null)
          }
          status={error ? <span className="text-destructive">{error}</span> : undefined}
          control={
            <div className="flex gap-2">
              {local && local.state !== "off" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !canControlTasks}
                  onClick={() => void stop()}
                >
                  Stop running tasks here
                </Button>
              ) : null}
              {!thisComputer ? (
                <Button
                  size="xs"
                  disabled={
                    busy ||
                    !canControlTasks ||
                    !serviceUrl ||
                    !session ||
                    !environmentId ||
                    !projectId
                  }
                  onClick={() => void allow()}
                >
                  Allow
                </Button>
              ) : null}
            </div>
          }
        />
        <SettingsRow
          title="Parallel assignments"
          description="Independent tasks can run in separate threads. Waiting for approval or an answer leaves room for other work. Tasks sharing a project folder take turns."
          control={
            <Select
              disabled={!serverSettingsAvailable}
              value={String(maxParallel)}
              onValueChange={(value) => {
                const count = Number(value);
                if (Number.isInteger(count) && count >= 1 && count <= 8) {
                  void updateServerSettings({ botTaskMaxParallel: count });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Parallel assignments">
                <SelectValue>{maxParallel} at a time</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((count) => (
                  <SelectItem key={count} value={String(count)}>
                    {count} at a time
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {localForService?.tasks?.map((task) => {
          const threadId = task.threadId;
          const status =
            task.phase === "waiting-approval"
              ? "Waiting for your approval."
              : task.phase === "waiting-input"
                ? "Waiting for your answer."
                : task.phase === "idle"
                  ? "Waiting for the existing thread or shared project folder."
                  : task.phase === "starting"
                    ? "Preparing the thread."
                    : task.phase === "completed"
                      ? "Delivering the completed result."
                      : task.phase === "failed"
                        ? "Delivering the failure result."
                        : "Running in Harness.";
          return (
            <SettingsRow
              key={task.taskId}
              title={task.title}
              description={status}
              control={
                threadId && environmentId ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId, threadId },
                      })
                    }
                  >
                    Open thread
                  </Button>
                ) : undefined
              }
            />
          );
        })}
        <SettingsRow
          title="Project for tasks"
          description={
            !hasProjectChoices
              ? "Add a project first. Task threads open in a project and use its settings."
              : projectId === NO_PROJECT
                ? "Each task gets its own new folder, so the bot can start something from scratch."
                : "Default project when an assignment does not select another. Bot threads use Auto mode and the selected project's model."
          }
          control={
            hasProjectChoices ? (
              <Select
                disabled={busy || !projectSelectionReady}
                value={projectId ?? ""}
                onValueChange={(value) => {
                  if (typeof value === "string" && value) void chooseProject(value);
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Project for tasks">
                  <SelectValue>{projectTitle ?? "Choose a project"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {scratchRoot !== null ? (
                    <SelectItem value={NO_PROJECT}>No project</SelectItem>
                  ) : null}
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

      <SettingsSection id="tritonai-bot-developer" title="Developer">
        <SettingsRow
          title="Show bot diagnostics"
          description="Shows the bot's records and controls beside its chat: the decision inbox, assignments, memory, routines and file inbox. For testing; the chat works without them."
          control={
            <Switch
              checked={diagnostics}
              onCheckedChange={(checked) =>
                void updateSettings({ tritonAiBotDiagnostics: Boolean(checked) })
              }
              aria-label="Show bot diagnostics"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
