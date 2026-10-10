import { useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
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
  const hydrated = useClientSettingsHydrated();
  const setting = useClientSettings((settings) => settings.tritonAiBotUrl);
  const updateSettings = useUpdateClientSettings();
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

  const description = !active
    ? "Off. Add a service address to show TritonAI Bot in the sidebar."
    : setting === null
      ? "Using this build's default service. Anyone with a UC San Diego account can sign in and get their own personal bot."
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
            {active ? (
              <Button size="xs" variant="outline" type="button" onClick={() => apply("")}>
                Turn off
              </Button>
            ) : null}
          </form>
        }
      />
    </SettingsSection>
  );
}
