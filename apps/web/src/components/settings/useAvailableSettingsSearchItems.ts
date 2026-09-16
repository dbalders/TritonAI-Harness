import {
  resolveSidebarStageBackdropVariant,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AuthAccessWriteScope } from "@t3tools/contracts";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { usePrimarySessionState } from "~/environments/primary";
import { primaryServerConfigAtom } from "~/state/server";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import { filterAvailableSettingsSearchItems } from "./settingsSearch";

export function useAvailableSettingsSearchItems() {
  const stageLabel = useEnvironmentStageLabel();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const primarySessionState = usePrimarySessionState();
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const desktopWsl = useEnvironmentQuery(isElectron ? desktopWslStateAtom : null);
  const canManageLocalBackend =
    isElectron ||
    ((primarySessionState.data?.authenticated &&
      primarySessionState.data.scopes?.includes(AuthAccessWriteScope)) ??
      false);

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        hasStageArtwork: resolveSidebarStageBackdropVariant(stageLabel) !== null,
        hasCloudPublicConfig: hasCloudPublicConfig(),
        hasPrimaryEnvironment: primaryEnvironmentId !== null,
        hasProviderSettingsEnvironment: environments.some((environment) =>
          isProviderSettingsEnvironmentAvailable({
            connectionPhase: environment.connection.phase,
            hasServerConfig: environment.serverConfig !== null,
          }),
        ),
        canManageLocalBackend,
        isWslSettingsRowVisible: isWslSettingsRowVisible({
          state: desktopWsl.data,
          error: desktopWsl.error,
        }),
        hasThreadAutoSettlement:
          primaryServerConfig?.environment.capabilities.threadAutoSettlement === true,
      }),
    [
      stageLabel,
      canManageLocalBackend,
      desktopWsl.data,
      desktopWsl.error,
      environments,
      primaryEnvironmentId,
      primaryServerConfig,
    ],
  );
}
