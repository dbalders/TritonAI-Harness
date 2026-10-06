import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerMemoryStatus, ServerMemorySyncStartResult } from "@t3tools/contracts";
import { FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DeviceCodePrompt } from "./PluginsSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function describeMemoryStatus(enabled: boolean, status: ServerMemoryStatus | null): string {
  if (!enabled || !status?.enabled) {
    return "Keep a daily summary of your threads that Codex agents can look back on.";
  }
  if (status.state === "error") {
    return `The last update failed: ${status.message ?? "unknown error"}`;
  }
  if (status.state === "summarizing") {
    return status.message ?? "Writing daily notes.";
  }
  return status.lastSummarizedDay
    ? `Caught up through ${status.lastSummarizedDay}. Today's note updates every four hours while you work.`
    : "Today's note appears a few hours into your day and updates every four hours.";
}

function describeSyncStatus(sync: ServerMemoryStatus["sync"]): string {
  switch (sync.state) {
    case "off":
    case "unavailable":
      return "Share this computer's memory with your other computers through your OneDrive.";
    case "signed-out":
      return sync.message ?? "Sign in with Microsoft to keep syncing.";
    case "error":
      return `Sync failed: ${sync.message ?? "unknown error"}`;
    case "syncing":
      return "Syncing with OneDrive.";
    case "idle": {
      const account = sync.account ? ` as ${sync.account}` : "";
      const when = sync.lastSyncedAt
        ? ` Last synced ${new Date(sync.lastSyncedAt).toLocaleString()}.`
        : "";
      const note = sync.message ? ` ${sync.message}` : "";
      return `Syncing${account} with ${sync.cloudFolder}.${when}${note}`;
    }
  }
}

type DeviceCodeFlow = Extract<ServerMemorySyncStartResult, { readonly kind: "device_code" }>;

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/**
 * Turning sync on either connects right away, reusing a saved or Microsoft 365
 * plugin sign-in, or shows a device code and polls until the user finishes.
 */
function MemorySyncRow({
  environmentId,
  status,
  refreshStatus,
}: {
  readonly environmentId: Parameters<typeof serverEnvironment.memoryStatus>[0]["environmentId"];
  readonly status: ServerMemoryStatus;
  readonly refreshStatus: () => void;
}) {
  const settings = useScopedSettings();
  const startSync = useAtomCommand(serverEnvironment.startMemorySync, { reportFailure: false });
  const pollSync = useAtomCommand(serverEnvironment.pollMemorySync, { reportFailure: false });
  const syncNow = useAtomCommand(serverEnvironment.syncMemoryNow, { reportFailure: false });
  const stopSync = useAtomCommand(serverEnvironment.stopMemorySync, { reportFailure: false });
  const signOut = useAtomCommand(serverEnvironment.signOutMemorySync, { reportFailure: false });
  const [flow, setFlow] = useState<DeviceCodeFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turnOn = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await startSync({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setError(failureMessage(result, "Could not start sync."));
      return;
    }
    if (result.value.kind === "device_code") setFlow(result.value);
    refreshStatus();
  }, [environmentId, refreshStatus, startSync]);

  // Poll the pending sign-in at the interval Microsoft asked for.
  useEffect(() => {
    if (!flow) return;
    let delaySeconds = flow.intervalSeconds;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() >= Date.parse(flow.expiresAt)) {
        setFlow(null);
        setError("The sign-in code expired. Turn sync on to try again.");
        return;
      }
      const result = await pollSync({ environmentId, input: { flowId: flow.flowId } });
      if (cancelled) return;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setFlow(null);
          setError(failureMessage(result, "Sign-in failed."));
        }
        return;
      }
      if (result.value.state === "pending") {
        delaySeconds = result.value.retryAfterSeconds ?? delaySeconds;
        timer = setTimeout(() => void poll(), delaySeconds * 1000);
        return;
      }
      setFlow(null);
      if (result.value.state !== "connected") {
        setError(result.value.message ?? "Sign-in did not finish. Turn sync on to try again.");
      }
      refreshStatus();
    };
    timer = setTimeout(() => void poll(), delaySeconds * 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [environmentId, flow, pollSync, refreshStatus]);

  const runAndRefresh = async (
    command: typeof syncNow | typeof stopSync | typeof signOut,
    fallback: string,
  ) => {
    setBusy(true);
    setError(null);
    const result = await command({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, fallback));
    }
    refreshStatus();
  };

  if (status.sync.state === "unavailable") return null;
  const enabled = settings.memorySyncEnabled;
  const signedIn = status.sync.signedIn ?? status.sync.account !== null;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["memorySyncEnabled"]}
      {...searchableSetting("memory-sync")}
      description={describeSyncStatus(status.sync)}
      status={error ? <span className="text-destructive">{error}</span> : undefined}
      control={
        <div className="flex items-center gap-2">
          {enabled && status.sync.state !== "signed-out" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || status.sync.state === "syncing"}
              onClick={() => void runAndRefresh(syncNow, "Could not sync.")}
            >
              <RefreshCwIcon />
              Sync now
            </Button>
          ) : null}
          {signedIn ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void runAndRefresh(signOut, "Could not sign out.")}
            >
              Sign out
            </Button>
          ) : null}
          <ScopedSwitch
            settingKeys={["memorySyncEnabled"]}
            checked={enabled || flow !== null}
            disabled={busy}
            onCheckedChange={(checked) => {
              if (checked) {
                void turnOn();
              } else {
                // The server also cancels a sign-in still in progress.
                setFlow(null);
                void runAndRefresh(stopSync, "Could not turn off sync.");
              }
            }}
            aria-label="Sync memory with OneDrive"
          />
        </div>
      }
    >
      {flow ? (
        <DeviceCodePrompt
          title="Sign in with Microsoft to sync memory"
          message="Enter this code on the Microsoft sign-in page with your UC San Diego account."
          userCode={flow.userCode}
          verificationUri={flow.verificationUri}
        />
      ) : status.sync.state === "signed-out" && enabled ? (
        <Button size="xs" className="mt-2" disabled={busy} onClick={() => void turnOn()}>
          Sign in with Microsoft
        </Button>
      ) : null}
    </SettingsRow>
  );
}

/**
 * Memory is per machine: each environment keeps its own vault, so the row only
 * renders when one environment is selected.
 */
export function MemorySettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const { data: status, refresh: refreshStatus } = useEnvironmentQuery(
    isEnvironmentScope ? serverEnvironment.memoryStatus({ environmentId, input: {} }) : null,
  );
  // The status otherwise refreshes every 30 seconds; show the switch's effect right away.
  const shownEnabled = useRef(settings.memoryEnabled);
  useEffect(() => {
    if (shownEnabled.current === settings.memoryEnabled) return;
    shownEnabled.current = settings.memoryEnabled;
    refreshStatus();
  }, [refreshStatus, settings.memoryEnabled]);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const [openError, setOpenError] = useState<string | null>(null);

  if (!isEnvironmentScope) return null;

  const openFolder = () => {
    const folder = status?.generalDirectoryPath;
    if (!folder) return;
    // Show the vault in Finder/Explorer; fall back to the preferred editor
    // only where the environment has no usable file manager.
    const availableEditors = environment?.serverConfig?.availableEditors ?? [];
    const editor = availableEditors.includes("file-manager")
      ? "file-manager"
      : resolveAndPersistPreferredEditor(availableEditors);
    if (!editor) {
      setOpenError("No available editors found.");
      return;
    }
    setOpenError(null);
    void (async () => {
      const result = await openInEditor({ environmentId, input: { cwd: folder, editor } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setOpenError(error instanceof Error ? error.message : "Unable to open the memory folder.");
      }
    })();
  };

  return (
    <SettingsSection id="memory" title="Memory">
      <SettingsRow
        serverScoped
        settingKeys={["memoryEnabled"]}
        {...searchableSetting("memory")}
        description={describeMemoryStatus(settings.memoryEnabled, status)}
        status={openError ? <span className="text-destructive">{openError}</span> : undefined}
        control={
          <div className="flex items-center gap-2">
            {settings.memoryEnabled && status ? (
              <Button
                size="xs"
                variant="outline"
                onClick={openFolder}
                aria-label="Open memory folder"
              >
                <FolderOpenIcon />
                Open folder
              </Button>
            ) : null}
            <ScopedSwitch
              settingKeys={["memoryEnabled"]}
              checked={settings.memoryEnabled}
              onCheckedChange={(checked) => updateSettings({ memoryEnabled: Boolean(checked) })}
              aria-label="Memory"
            />
          </div>
        }
      />
      {settings.memoryEnabled && status ? (
        <MemorySyncRow
          environmentId={environmentId}
          status={status}
          refreshStatus={refreshStatus}
        />
      ) : null}
    </SettingsSection>
  );
}
