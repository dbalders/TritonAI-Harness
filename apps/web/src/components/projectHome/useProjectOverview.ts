import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ProjectOverviewSnapshot } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** Mounted once per physical project. The server owns the durable cache and dedupes generation. */
export function useProjectOverview({
  environmentId,
  projectId,
  connected,
  supported,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  connected: boolean;
  supported: boolean;
}) {
  const allowed = useAtomValue(
    serverEnvironment.ensureProjectOverview.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    connected && supported
      ? serverEnvironment.projectOverview({ environmentId, input: { projectId } })
      : null,
  );
  const [saved, setSaved] = useState<ProjectOverviewSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const ensure = useAtomCommand(serverEnvironment.ensureProjectOverview, {
    label: "Update project next steps",
    reportFailure: false,
  });
  const [lastQueryData, setLastQueryData] = useState(query.data);
  if (query.data !== lastQueryData) {
    setLastQueryData(query.data);
    if (query.data) setSaved(query.data);
  }
  const refresh = async (force = false) => {
    if (!connected || !supported || !allowed || inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    setRequestError(null);
    return await (async () => {
      try {
        const result = await ensure({ environmentId, input: { projectId, force } });
        if (result._tag !== "Success") setRequestError("Couldn't check next steps. Try again.");
      } catch {
        setRequestError("Couldn't check next steps. Try again.");
      }
    })().finally(async () => {
      inFlight.current = false;
      setChecking(false);
    });
  };
  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);
  const snapshot = connected ? (query.data ?? saved) : saved;
  return {
    snapshot,
    checking,
    busy: checking || snapshot?.generation.state === "generating",
    error: requestError ?? query.error ?? snapshot?.generation.message ?? null,
    canRefresh: connected && supported && allowed,
    refresh,
  };
}
export type ProjectOverviewView = ReturnType<typeof useProjectOverview>;
