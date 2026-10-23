import { Link, useNavigate } from "@tanstack/react-router";
import { useBotTaskComputerControl } from "../../hooks/useBotTaskComputerControl";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Opt-in never signs in, connects Microsoft or grants execution permission. */
export function BotOptInSettings() {
  const { enabled, hydrated, serviceUrl, hiddenPairing, busy, error, change } =
    useBotTaskComputerControl();
  const navigate = useNavigate();
  return (
    <SettingsRow
      {...searchableSetting("tritonai-bot-opt-in")}
      description="Your personal bot for Outlook, calendar, OneDrive and Microsoft To Do. Sign in with your own account, then choose your Microsoft permissions. Running approved tasks on this computer requires a separate Allow. Turning this off signs out and stops new tasks here; work already running and saved result delivery can finish."
      status={
        <div className="space-y-2">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
          {hiddenPairing ? (
            <p role="status">
              Bot tasks are allowed on this Harness. Experimental Bot is{" "}
              {enabled ? "unavailable" : "off"} in this app. Stopping tasks here affects every
              client of this Harness. Work already running and saved result delivery can finish.
            </p>
          ) : null}
          {!serviceUrl ? (
            <p>
              The Bot service is unavailable. Set a valid service address in{" "}
              <Link to="/settings/connections" className="underline">
                Settings → Connections
              </Link>{" "}
              or contact your administrator.
            </p>
          ) : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          {hiddenPairing ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(false)}>
              Stop Bot tasks here
            </Button>
          ) : null}
          {enabled && serviceUrl ? (
            <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/dot" })}>
              Open Bot
            </Button>
          ) : null}
          <Switch
            aria-label="TritonAI Bot (experimental)"
            checked={enabled}
            disabled={!hydrated || busy || (!enabled && !serviceUrl)}
            onCheckedChange={(checked) => void change(Boolean(checked))}
          />
        </div>
      }
    />
  );
}
