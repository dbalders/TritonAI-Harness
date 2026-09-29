import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ServerMemoryStatus } from "@t3tools/contracts";
import { FolderOpenIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
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
    ? `Caught up through ${status.lastSummarizedDay}. Days without thread activity have no note.`
    : "The first daily note is written after today ends.";
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
    const editor = resolveAndPersistPreferredEditor(
      environment?.serverConfig?.availableEditors ?? [],
    );
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
    </SettingsSection>
  );
}
