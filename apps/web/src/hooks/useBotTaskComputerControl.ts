import { useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { clearBotSessions, resolveBotServiceUrl } from "../components/dot/botService";
import { DotClient, readDotSession } from "../components/dot/dotClient";
import { updateClientSettings, useClientSettings, useClientSettingsHydrated } from "./useSettings";

/** Shared by Experimental settings and the always-mounted app permission notice. */
export function useBotTaskComputerControl() {
  const enabled = useClientSettings((settings) => settings.tritonAiBotEnabled);
  const setting = useClientSettings((settings) => settings.tritonAiBotUrl);
  const hydrated = useClientSettingsHydrated();
  const environmentId = usePrimaryEnvironmentId();
  const stop = useAtomCommand(serverEnvironment.stopBotTaskComputer, { reportFailure: false });
  const { data: local, refresh: refreshLocal } = useEnvironmentQuery(
    environmentId ? serverEnvironment.botTaskComputer({ environmentId, input: {} }) : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serviceUrl = resolveBotServiceUrl(setting);
  const permissionUnknown = Boolean(hydrated && local?.state === "error" && local.apiUrl === null);
  const hiddenPairing = Boolean(
    hydrated &&
    !permissionUnknown &&
    (!enabled || !serviceUrl) &&
    local &&
    local.state !== "off" &&
    local.state !== "replaced",
  );
  const stopPairing = async () => {
    if (!environmentId)
      throw new Error("Connect to your Harness to stop Bot tasks before disabling it.");
    // The worker can belong to another service. Never forward this service's
    // owner token to that worker; without its matching session, stop locally.
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
    if (serviceUrl && serviceUrl !== pairedUrl) {
      const currentSession = readDotSession(sessionStorage, serviceUrl);
      if (currentSession)
        await new DotClient(serviceUrl).signOut(currentSession).catch(() => undefined);
    }
    clearBotSessions(sessionStorage);
  };
  const change = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!next) await stopPairing();
      await updateClientSettings({
        tritonAiBotEnabled: next,
        ...(next && setting !== null && !setting.trim() ? { tritonAiBotUrl: null } : {}),
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not change TritonAI Bot. Try again.",
      );
    }
    setBusy(false);
  };
  return {
    enabled,
    hydrated,
    environmentId,
    serviceUrl,
    hiddenPairing,
    permissionUnknown,
    busy,
    error,
    change,
    stopPairing,
    refreshLocal,
  };
}
