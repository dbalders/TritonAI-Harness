import { DownloadIcon, PuzzleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function EmptyPluginSection({
  title,
  icon,
  emptyTitle,
  emptyDescription,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}) {
  return (
    <SettingsSection
      title={title}
      icon={icon}
      headerAction={<span className="text-[11px] text-muted-foreground">0</span>}
    >
      <div className="p-8">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PuzzleIcon />
            </EmptyMedia>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            <EmptyDescription>{emptyDescription}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </SettingsSection>
  );
}

export function PluginsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <EmptyPluginSection
        title="Installed Plugins"
        icon={<PuzzleIcon className="size-3.5" />}
        emptyTitle="No installed plugins"
        emptyDescription="Installed plugins will appear here."
      />

      <EmptyPluginSection
        title="Available Plugins"
        icon={<DownloadIcon className="size-3.5" />}
        emptyTitle="No available plugins"
        emptyDescription="Available TritonAI plugins will appear here."
      />
    </SettingsPageContainer>
  );
}
