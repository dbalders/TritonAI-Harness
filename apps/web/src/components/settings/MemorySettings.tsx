import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerMemoryStatus,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { ChevronDownIcon, FolderOpenIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DeviceCodePrompt } from "./PluginsSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useMemorySyncActions, type MemoryDeviceCodeFlow } from "./useMemorySyncActions";
import { useScopedSettingsMixed, useUpdateScopedSettings } from "./useScopedSettings";

type MemoryEnvironment = ReturnType<typeof useSettingsScope>["environments"][number];

function describeMemoryStatus(status: ServerMemoryStatus): string {
  if (!status.enabled) return "Memory off";
  if (status.state === "error") return `Memory update failed: ${status.message ?? "unknown error"}`;
  if (status.state === "summarizing") return "Writing daily notes";
  return status.lastSummarizedDay
    ? `Caught up through ${status.lastSummarizedDay}`
    : "Waiting for the first daily note";
}

function describeSyncStatus(sync: ServerMemoryStatus["sync"]): string {
  switch (sync.state) {
    case "off":
      return "Sync off";
    case "unavailable":
      return "OneDrive sync unavailable on this version";
    case "signed-out":
      return "Microsoft sign-in required";
    case "error":
      return `Sync failed: ${sync.message ?? "unknown error"}`;
    case "syncing":
      return "Syncing with OneDrive";
    case "idle":
      return `${sync.account ? `Connected as ${sync.account}` : "Connected to OneDrive"}${sync.lastSyncedAt ? ` · Last synced ${new Date(sync.lastSyncedAt).toLocaleString()}` : ""}${sync.message ? ` · ${sync.message}` : ""}`;
  }
}

function MemoryValuePicker({
  label,
  value,
  disabled,
  multiple,
  onChange,
}: {
  readonly label: string;
  readonly value: "on" | "off" | "mixed";
  readonly disabled: boolean;
  readonly multiple: boolean;
  readonly onChange: (enabled: boolean) => void;
}) {
  return (
    <Select
      value={value === "mixed" ? null : value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "on" || next === "off") onChange(next === "on");
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{value === "mixed" ? "Mixed" : value === "on" ? "On" : "Off"}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        <SelectItem value="on">{multiple ? "Turn on for all" : "On"}</SelectItem>
        <SelectItem value="off">{multiple ? "Turn off for all" : "Off"}</SelectItem>
      </SelectPopup>
    </Select>
  );
}

/** The code belongs to the named environment; the verification page opens on this client. */
function MemorySignIn({
  environmentId,
  label,
  flow,
  finish,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly flow: MemoryDeviceCodeFlow;
  readonly finish: (id: EnvironmentId, error: string | null) => void;
}) {
  const poll = useAtomCommand(serverEnvironment.pollMemorySync, { reportFailure: false });
  useEffect(() => {
    let cancelled = false;
    let intervalSeconds = flow.intervalSeconds;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (Date.now() >= Date.parse(flow.expiresAt)) {
        finish(environmentId, "The sign-in code expired. Choose Sign in to try again.");
        return;
      }
      const result = await poll({ environmentId, input: { flowId: flow.flowId } });
      if (cancelled) return;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          finish(
            environmentId,
            failure instanceof Error ? failure.message : "Sign-in failed. Try again.",
          );
        }
      } else if (result.value.state === "pending") {
        intervalSeconds = result.value.retryAfterSeconds ?? intervalSeconds;
        timer = setTimeout(() => void check(), intervalSeconds * 1000);
      } else {
        finish(
          environmentId,
          result.value.state === "connected"
            ? null
            : (result.value.message ?? "Sign-in did not finish. Try again."),
        );
      }
    };
    timer = setTimeout(() => void check(), flow.intervalSeconds * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentId, finish, flow, poll]);
  return (
    <DeviceCodePrompt
      title={`Connect OneDrive on ${label}`}
      message={`Open Microsoft sign-in on this computer and enter the code to authorize ${label}.`}
      userCode={flow.userCode}
      verificationUri={flow.verificationUri}
    />
  );
}

export function MemorySettingsSection() {
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const memoryMixed = useScopedSettingsMixed(["memoryEnabled"]);
  const syncMixed = useScopedSettingsMixed(["memorySyncEnabled"]);
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  const registry = useContext(RegistryContext);
  const [expanded, setExpanded] = useState(false);
  const [folderErrors, setFolderErrors] = useState<Readonly<Record<string, string>>>({});
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const statusesAtom = Atom.make((get) =>
    connectedEnvironments.map((environment) => {
      const result = get(
        serverEnvironment.memoryStatus({ environmentId: environment.environmentId, input: {} }),
      );
      return {
        environmentId: environment.environmentId,
        status: Option.getOrNull(AsyncResult.value(result)),
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      };
    }),
  );
  const statuses = useAtomValue(statusesAtom);
  const refresh = (environmentId: EnvironmentId) => {
    registry.refresh(serverEnvironment.memoryStatus({ environmentId, input: {} }));
  };
  const { operations, run, finishSignIn } = useMemorySyncActions(refresh);
  const settingsKey = JSON.stringify(
    connectedEnvironments.map((environment) => [
      environment.environmentId,
      environment.serverConfig?.settings.memoryEnabled,
      environment.serverConfig?.settings.memorySyncEnabled,
    ]),
  );
  useEffect(() => {
    for (const [id] of JSON.parse(settingsKey) as [EnvironmentId, boolean, boolean][]) refresh(id);
  }, [refresh, settingsKey]);

  const isEnvironmentScope = scope.kind === "all" || scope.kind === "environment";
  const canWriteAll =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((environment) => writable.has(environment.environmentId));
  const memoryOn = connectedEnvironments.every(
    (environment) => environment.serverConfig?.settings.memoryEnabled,
  );
  const syncOn = connectedEnvironments.every(
    (environment) => environment.serverConfig?.settings.memorySyncEnabled,
  );
  const offline = environments.filter(
    (environment) =>
      !connectedEnvironments.some(
        (connected) => connected.environmentId === environment.environmentId,
      ),
  );
  const anyBusy = Object.values(operations).some((operation) => operation.busy);
  const unavailable = statuses.filter((entry) => entry.status?.sync.state === "unavailable").length;
  const pendingStatus = statuses.some((entry) => !entry.status || entry.error !== null);
  const attention =
    statuses.filter(
      (entry) =>
        entry.error ||
        entry.status?.state === "error" ||
        entry.status?.sync.state === "error" ||
        entry.status?.sync.state === "signed-out",
    ).length + Object.values(operations).filter((operation) => operation.error).length;
  const syncConnected = statuses.filter(
    (entry) => entry.status?.sync.state === "idle" || entry.status?.sync.state === "syncing",
  ).length;
  const pendingSignIns = Object.values(operations).filter((operation) => operation.flow).length;
  const openDetails = expanded;

  const setSync = (enabled: boolean) => {
    setExpanded(true);
    for (const environment of connectedEnvironments) {
      const id = environment.environmentId;
      const entry = statuses.find((candidate) => candidate.environmentId === id);
      if (
        !writable.has(id) ||
        !entry?.status ||
        entry.error ||
        (enabled && entry.status.sync.state === "unavailable")
      )
        continue;
      void run(id, enabled ? "start" : "stop");
    }
  };

  const openFolder = async (environment: MemoryEnvironment, folder: string) => {
    const available = environment.serverConfig?.availableEditors ?? [];
    const editor = available.includes("file-manager")
      ? "file-manager"
      : resolveAndPersistPreferredEditor(available);
    if (!editor) {
      setFolderErrors((current) => ({
        ...current,
        [environment.environmentId]: "No available editors found.",
      }));
      return;
    }
    setFolderErrors((current) => ({ ...current, [environment.environmentId]: "" }));
    const result = await openInEditor({
      environmentId: environment.environmentId,
      input: { cwd: folder, editor },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setFolderErrors((current) => ({
        ...current,
        [environment.environmentId]:
          failure instanceof Error ? failure.message : "Unable to open the memory folder.",
      }));
    }
  };

  return (
    <SettingsSection id="memory" title="Memory">
      <SettingsRow
        serverScoped
        settingKeys={["memoryEnabled"]}
        {...searchableSetting("memory")}
        description="Keep daily summaries and project history to review and reuse through Ideas and project next steps."
        status={
          connectedEnvironments.length
            ? `${connectedEnvironments.filter((environment) => environment.serverConfig?.settings.memoryEnabled).length} of ${connectedEnvironments.length} connected environments on`
            : "Connect an environment to manage memory."
        }
        control={
          <MemoryValuePicker
            label="Memory"
            value={memoryMixed ? "mixed" : memoryOn ? "on" : "off"}
            disabled={!canWriteAll}
            multiple={environments.length > 1}
            onChange={(enabled) => updateSettings({ memoryEnabled: enabled })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["memorySyncEnabled"]}
        {...searchableSetting("memory-sync")}
        description="Share memory between your computers through your OneDrive."
        status={
          <span role="status">
            {syncConnected} connected to OneDrive
            {pendingSignIns > 0 ? ` · ${pendingSignIns} waiting for sign-in` : ""}
            {unavailable > 0 ? ` · ${unavailable} unavailable` : ""}
            {pendingStatus ? " · Some statuses unavailable or loading" : ""}
            {attention > 0 ? " · Needs attention below" : ""}
            {!memoryOn || memoryMixed ? " · Sync pauses where Memory is off" : ""}
          </span>
        }
        control={
          <MemoryValuePicker
            label="Sync memory with OneDrive"
            value={syncMixed ? "mixed" : syncOn ? "on" : "off"}
            disabled={!canWriteAll || anyBusy || pendingStatus}
            multiple={environments.length > 1}
            onChange={setSync}
          />
        }
      />
      {isEnvironmentScope ? (
        <div className="px-3 py-3 sm:px-4">
          {offline.length > 0 ? (
            <p className="mb-3 text-xs text-muted-foreground" role="status">
              {offline.map((environment) => environment.label).join(", ")}: offline. Reconnect to
              apply changes.
            </p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-between"
            aria-expanded={openDetails}
            aria-controls="memory-environments"
            onClick={() => setExpanded(!openDetails)}
          >
            Manage environments <ChevronDownIcon className={openDetails ? "rotate-180" : ""} />
          </Button>
          <div id="memory-environments" hidden={!openDetails}>
            {environments.map((environment) => {
              const id = environment.environmentId;
              const entry = statuses.find((candidate) => candidate.environmentId === id);
              const operation = operations[id];
              const status = entry?.status;
              const connected = connectedEnvironments.some(
                (candidate) => candidate.environmentId === id,
              );
              const canWrite = writable.has(id);
              const disabled =
                !connected || !canWrite || operation?.busy === true || !status || !!entry?.error;
              const signedIn =
                status?.sync.signedIn ??
                (status?.sync.account !== null && status?.sync.account !== undefined);
              const enabled = environment.serverConfig?.settings.memorySyncEnabled === true;
              return (
                <div key={id} className="border-t border-border/60 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="break-words font-medium">{environment.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {!connected
                          ? "Offline · Reconnect to manage memory"
                          : (entry?.error ??
                            (status ? describeMemoryStatus(status) : "Loading memory status…"))}
                      </p>
                      {status && !entry?.error && connected ? (
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {!environment.serverConfig?.settings.memoryEnabled && enabled
                            ? "Sync paused while Memory is off · "
                            : ""}
                          {describeSyncStatus(status.sync)}
                        </p>
                      ) : null}
                      {connected && !canWrite ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          This connection cannot change settings.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {connected && entry?.error ? (
                        <Button size="xs" variant="outline" onClick={() => refresh(id)}>
                          Retry
                        </Button>
                      ) : null}
                      {status && connected && !entry?.error ? (
                        <>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              void openFolder(environment, status.generalDirectoryPath)
                            }
                            aria-label={`Open memory folder on ${environment.label}`}
                          >
                            <FolderOpenIcon />
                            Open folder
                          </Button>
                          {operation?.flow ? (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={operation.busy || !canWrite}
                              onClick={() => void run(id, "stop")}
                            >
                              Cancel sign-in
                            </Button>
                          ) : status.sync.state !== "unavailable" ? (
                            <>
                              {enabled && status.sync.state !== "signed-out" ? (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={
                                    disabled || !status.enabled || status.sync.state === "syncing"
                                  }
                                  onClick={() => void run(id, "sync")}
                                >
                                  Sync now
                                </Button>
                              ) : (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={disabled}
                                  onClick={() => void run(id, "start")}
                                >
                                  {status.sync.state === "signed-out" || !signedIn
                                    ? "Sign in"
                                    : "Turn on sync"}
                                </Button>
                              )}
                              {enabled ? (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={disabled}
                                  onClick={() => void run(id, "stop")}
                                >
                                  Turn off sync
                                </Button>
                              ) : null}
                              {signedIn ? (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  disabled={disabled}
                                  onClick={() => void run(id, "sign-out")}
                                >
                                  Sign out
                                </Button>
                              ) : null}
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </div>
                  {operation?.error || folderErrors[id] ? (
                    <p role="alert" className="mt-2 break-words text-xs text-destructive">
                      {operation?.error ?? folderErrors[id]}
                    </p>
                  ) : null}
                  {operation?.flow && connected ? (
                    <MemorySignIn
                      environmentId={id}
                      label={environment.label}
                      flow={operation.flow}
                      finish={finishSignIn}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
