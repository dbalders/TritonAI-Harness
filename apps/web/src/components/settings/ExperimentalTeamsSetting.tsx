import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ExperimentalTeamsSetting() {
  const { scope, targets } = useSettingsScope();
  const enabled = useScopedSettings((settings) => settings.experimentalTeamsEnabled);
  const mixed = useScopedSettingsMixed(["experimentalTeamsEnabled"]);
  const canWrite = useScopedSettingsWriteAllowed();
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const destination = targets.length === 1 ? targets[0]?.environmentId : undefined;
  return (
    <SettingsRow
      {...searchableSetting("experimental-teams")}
      serverScoped
      settingKeys={["experimentalTeamsEnabled"]}
      description="Create teams with your UC San Diego account and share team documents and summaries. Off by default for each environment. Turning it off disables new Teams operations and pauses background sharing and team skills here; existing teams and links are kept."
      control={
        <div className="flex items-center gap-2">
          {enabled && !mixed ? (
            <Button
              size="sm"
              variant="outline"
              render={
                <Link to="/teams" search={destination ? { environmentId: destination } : {}} />
              }
            >
              Open Teams
            </Button>
          ) : null}
          <Switch
            checked={enabled && !mixed}
            disabled={!canWrite || projectScope}
            onCheckedChange={(checked) =>
              updateSettings({ experimentalTeamsEnabled: Boolean(checked) })
            }
            aria-label="Teams (experimental)"
          />
        </div>
      }
    />
  );
}
