import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
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
  const { data: local, refresh: refreshLocal } = useEnvironmentQuery(
    environmentId ? serverEnvironment.botTaskComputer({ environmentId, input: {} }) : null,
  );
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serviceUrl = resolveBotServiceUrl(setting);
  const earlierPairing =
    (!enabled || !serviceUrl) && local && local.state !== "off" && local.state !== "replaced";
  const stopPairing = async () => {
    if (!environmentId)
      throw new Error("Connect to your Harness to stop Bot tasks before disabling it.");
    // An upgrade can retain a worker for a different address than the current setting.
    // Only send an owner token to the service that issued it.
    const pairedUrl = local?.apiUrl ?? serviceUrl;
    const session = pairedUrl ? readDotSession(sessionStorage, pairedUrl) : null;
    const result = await stop({
      environmentId,
      input: { apiUrl: pairedUrl, ownerToken: session?.ownerToken ?? null },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    refreshLocal();
    if (pairedUrl && session)
      await new DotClient(pairedUrl).signOut(session).catch(() => undefined);
    clearBotSessions(sessionStorage);
  };
  const change = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!next) {
        // Stop claiming before hiding the UI. Held results remain durable and deliverable.
        await stopPairing();
      }
      await update({
        tritonAiBotEnabled: next,
        ...(next && setting !== null && !setting.trim() ? { tritonAiBotUrl: null } : {}),
      });
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
        <>
          {error ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : null}
          {earlierPairing ? (
            <span role="status">
              An earlier pairing is still active on this Harness while Experimental Bot is{" "}
              {enabled ? "unavailable" : "off"}. Stop new tasks here to retire that permission. Work
              already running and saved result delivery can finish.
            </span>
          ) : null}
          {!serviceUrl
            ? "The Bot service is unavailable. Set a valid service address below or contact your administrator."
            : null}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          {earlierPairing ? (
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
