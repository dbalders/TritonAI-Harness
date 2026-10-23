import { useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  BUILD_DEFAULT_BOT_SERVICE_URL,
  clearBotSessions,
  normalizeBotServiceUrl,
  resolveBotServiceUrl,
} from "../dot/botService";
import { DotClient, readDotSession } from "../dot/dotClient";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Where the personal TritonAI Bot lives. Changing it signs out of the previous service. */
export function TritonAiBotSettings() {
  const enabled = useClientSettings((settings) => settings.tritonAiBotEnabled);
  const hydrated = useClientSettingsHydrated();
  const setting = useClientSettings((settings) => settings.tritonAiBotUrl);
  const updateSettings = updateClientSettings;
  const environmentId = usePrimaryEnvironmentId();
  const stop = useAtomCommand(serverEnvironment.stopBotTaskComputer, { reportFailure: false });
  const active = resolveBotServiceUrl(setting);
  // null shows the saved address, so a change elsewhere is never hidden behind a stale edit.
  const [edit, setEdit] = useState<string | null>(null);
  const draft = edit ?? active ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (value: string | null) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (resolveBotServiceUrl(value) !== active) {
        if (!environmentId)
          throw new Error("Connect to your Harness to stop Bot tasks before changing services.");
        const session = active ? readDotSession(sessionStorage, active) : null;
        const result = await stop({
          environmentId,
          input: { apiUrl: active, ownerToken: session?.ownerToken ?? null },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (active && session) await new DotClient(active).signOut(session).catch(() => undefined);
        clearBotSessions(sessionStorage);
      }
      await updateSettings({ tritonAiBotUrl: value });
      setEdit(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the Bot service.");
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!draft.trim()) return void apply(null);
    const url = normalizeBotServiceUrl(draft);
    if (!url) {
      setError("Enter an HTTPS address, such as https://bot.example.edu.");
      return;
    }
    void apply(url === BUILD_DEFAULT_BOT_SERVICE_URL ? null : url);
  };

  // Keep configuration recovery reachable when an older override is unusable.
  if (!enabled && active) return null;

  const description = !active
    ? "No service configured. Use the managed default or contact your administrator."
    : setting === null || !setting.trim()
      ? "Using this build's default service. Sign in with your own account if this service is available to you."
      : "Using a custom service. Your bot session stays with this address.";

  return (
    <SettingsSection {...searchableSetting("tritonai-bot")}>
      <SettingsRow
        title="Service address"
        description={description}
        status={
          error ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : (
            "Clearing the address restores the managed default. Changing services stops new tasks here and signs you out of the previous service. Running work and saved result delivery can finish. The mobile app does not support TritonAI Bot yet."
          )
        }
        control={
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <Input
              aria-label="TritonAI Bot service address"
              value={draft}
              disabled={!hydrated || busy}
              onChange={(event) => setEdit(event.target.value)}
              placeholder="https://"
              className="w-72"
            />
            <Button
              size="xs"
              type="submit"
              disabled={!hydrated || busy || draft.trim() === (active ?? "")}
            >
              Save
            </Button>
            {setting !== null && BUILD_DEFAULT_BOT_SERVICE_URL ? (
              <Button
                size="xs"
                variant="outline"
                type="button"
                disabled={busy}
                onClick={() => void apply(null)}
              >
                Use default
              </Button>
            ) : null}
          </form>
        }
      />
    </SettingsSection>
  );
}
