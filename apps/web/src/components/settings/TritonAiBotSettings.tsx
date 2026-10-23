import { useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  updateClientSettings,
} from "../../hooks/useSettings";
import {
  BUILD_DEFAULT_BOT_SERVICE_URL,
  clearBotSessions,
  normalizeBotServiceUrl,
  resolveBotServiceUrl,
} from "../dot/botService";
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
  const active = resolveBotServiceUrl(setting);
  // null shows the saved address, so a change elsewhere is never hidden behind a stale edit.
  const [edit, setEdit] = useState<string | null>(null);
  const draft = edit ?? active ?? "";
  const [error, setError] = useState<string | null>(null);

  const apply = (value: string | null) => {
    setError(null);
    setEdit(null);
    if (resolveBotServiceUrl(value) !== active) clearBotSessions(sessionStorage);
    void updateSettings({ tritonAiBotUrl: value });
  };
  const save = () => {
    if (!draft.trim()) return apply("");
    const url = normalizeBotServiceUrl(draft);
    if (!url) {
      setError("Enter an HTTPS address, such as https://bot.example.edu.");
      return;
    }
    apply(url === BUILD_DEFAULT_BOT_SERVICE_URL ? null : url);
  };

  if (!enabled) return null;

  const description = !active
    ? "No service configured. Use the managed default or contact your administrator."
    : setting === null
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
            "Changing or clearing the address signs you out of the previous service. The mobile app does not support TritonAI Bot yet."
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
              disabled={!hydrated}
              onChange={(event) => setEdit(event.target.value)}
              placeholder="https://"
              className="w-72"
            />
            <Button size="xs" type="submit" disabled={!hydrated || draft.trim() === (active ?? "")}>
              Save
            </Button>
            {setting !== null && BUILD_DEFAULT_BOT_SERVICE_URL ? (
              <Button size="xs" variant="outline" type="button" onClick={() => apply(null)}>
                Use default
              </Button>
            ) : null}
          </form>
        }
      />
    </SettingsSection>
  );
}
