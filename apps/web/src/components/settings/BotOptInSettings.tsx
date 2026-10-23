import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { clearBotSessions, resolveBotServiceUrl } from "../dot/botService";
import { DotClient, readDotSession } from "../dot/dotClient";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Opt-in never signs in, connects Microsoft or grants execution permission. */
export function BotOptInSettings() {
  const enabled = useClientSettings((settings) => settings.tritonAiBotEnabled);
  const setting = useClientSettings((settings) => settings.tritonAiBotUrl);
  const hydrated = useClientSettingsHydrated();
  const update = updateClientSettings;
  const environmentId = usePrimaryEnvironmentId();
  const stop = useAtomCommand(serverEnvironment.stopBotTaskComputer, { reportFailure: false });
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serviceUrl = resolveBotServiceUrl(setting);
  const change = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!next) {
        const session = serviceUrl ? readDotSession(sessionStorage, serviceUrl) : null;
        // Stop claiming before hiding the UI. Held results remain durable and deliverable.
        if (!environmentId)
          throw new Error("Connect to your Harness to stop Bot tasks before disabling it.");
        const result = await stop({
          environmentId,
          input: { apiUrl: serviceUrl, ownerToken: session?.ownerToken ?? null },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (serviceUrl && session)
          await new DotClient(serviceUrl).signOut(session).catch(() => undefined);
        clearBotSessions(sessionStorage);
      }
      await update({ tritonAiBotEnabled: next });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not change TritonAI Bot. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      {...searchableSetting("tritonai-bot-opt-in")}
      description="Your personal bot for Outlook, calendar, OneDrive and Microsoft To Do. Sign in with your own account, then choose your Microsoft permissions. Running approved tasks on this computer requires a separate Allow. Turning this off signs out and stops new tasks here; work already running and saved result delivery can finish."
      status={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : !serviceUrl ? (
          "The Bot service is unavailable in this build. Contact your administrator."
        ) : undefined
      }
      control={
        <div className="flex items-center gap-2">
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
