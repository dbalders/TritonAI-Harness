import {
  resetGettingStartedProgress,
  useGettingStartedState,
  useOpenGettingStartedGuide,
} from "../../onboarding/gettingStarted";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function GettingStartedSettingsSection() {
  const guide = useGettingStartedState();
  const openGuide = useOpenGettingStartedGuide();

  return (
    <SettingsSection title="Getting started">
      <SettingsRow
        {...searchableSetting("getting-started")}
        description={
          guide.isComplete
            ? "You finished every step. Start over to walk through the basics again."
            : `${guide.completedCount} of ${guide.total} steps done. A short hands-on walkthrough of conversations, files, connected tools, and skills.`
        }
        control={
          <div className="flex items-center gap-2">
            {guide.completedCount > 0 ? (
              <Button size="xs" variant="ghost" onClick={resetGettingStartedProgress}>
                Start over
              </Button>
            ) : null}
            <Button size="xs" variant="outline" onClick={() => void openGuide()}>
              Open guide
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
