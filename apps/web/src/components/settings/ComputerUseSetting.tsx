import { describeComputerUseReadiness, type DesktopComputerUseState } from "@t3tools/contracts";
import { CheckIcon, CircleAlertIcon, MonitorIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { watchComputerUseState } from "./watchComputerUseState";

export function ComputerUseSetting() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [state, setState] = useState<DesktopComputerUseState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const watcher = useRef<ReturnType<typeof watchComputerUseState> | null>(null);

  useEffect(() => {
    if (!bridge || pending) return;
    const observer = watchComputerUseState({
      read: () => bridge.getComputerUseState(),
      onState: (next) => {
        setState((previous) =>
          previous &&
          previous.enabled === next.enabled &&
          previous.available === next.available &&
          previous.running === next.running &&
          previous.accessibilityPermission === next.accessibilityPermission &&
          previous.screenRecordingPermission === next.screenRecordingPermission
            ? previous
            : next,
        );
        setReadError(null);
      },
      onError: (cause) =>
        setReadError(cause instanceof Error ? cause.message : "Could not check computer use."),
    });
    watcher.current = observer;
    return () => {
      observer.stop();
      watcher.current = null;
    };
  }, [bridge, pending]);

  if (!bridge) return null;
  const readiness = state ? describeComputerUseReadiness(state) : null;
  const needsPermissions =
    state?.accessibilityPermission === false || state?.screenRecordingPermission === false;
  const updateEnabled = async (enabled: boolean) => {
    watcher.current?.stop();
    setPending(true);
    setError(null);
    try {
      setState(await bridge.setComputerUseEnabled(enabled));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update computer use.");
    } finally {
      setPending(false);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("computer-use")}
      description="Let the agent see and control desktop apps. Available with the Codex provider on this computer."
      control={
        <Switch
          aria-label="Computer use"
          checked={state?.enabled ?? false}
          disabled={pending || state === null || (!state.available && !state.enabled)}
          onCheckedChange={(enabled) => void updateEnabled(Boolean(enabled))}
        />
      }
    >
      <div className="my-3 rounded-lg border border-border/70 bg-muted/20 p-3 text-sm">
        <div className="flex items-center gap-2 font-medium" role="status">
          <MonitorIcon className="size-4 text-info-foreground" aria-hidden />
          <span>
            {pending ? "Updating computer use…" : (readiness?.label ?? "Checking permissions…")}
          </span>
        </div>
        {state && (
          <ul className="mt-3 space-y-2 text-xs">
            {(
              [
                [
                  "Accessibility",
                  "Click, type, and interact with apps",
                  state.accessibilityPermission,
                ],
                [
                  "Screen Recording",
                  "See windows and screen content",
                  state.screenRecordingPermission,
                ],
              ] as const
            ).map(([label, description, granted]) => (
              <li key={label} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {granted === false ? (
                  <CircleAlertIcon className="size-3.5 text-warning" aria-hidden />
                ) : (
                  <CheckIcon className="size-3.5 text-success" aria-hidden />
                )}
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground">{description}</span>
                <span className="ms-auto font-medium">
                  {granted === null ? "Not required" : granted ? "Allowed" : "Required"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{readiness?.detail}</p>
        {state?.enabled && state.available && needsPermissions && (
          <p className="mt-2 text-xs text-muted-foreground">
            Checking automatically while this panel is open. If access is already allowed in System
            Settings, quit and reopen this copy of TritonAI Harness.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Ask “Use computer use to open Notes” or choose{" "}
          <span className="font-mono">/computer-use</span> in chat.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {state?.enabled && state.available && (!state.running || needsPermissions) && (
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              onClick={() => void updateEnabled(true)}
            >
              {needsPermissions ? "Request permissions" : "Restart Harness"}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => void watcher.current?.refresh()}
          >
            Check again
          </Button>
        </div>
        {(error || readError) && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error || readError}
          </p>
        )}
      </div>
    </SettingsRow>
  );
}
