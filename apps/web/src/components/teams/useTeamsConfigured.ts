import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useReducer } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

// Teams stays off until the environment's account service is configured, which only changes when
// its server restarts, so one answer per environment serves every surface for the session.
const configuredByEnvironment = new Map<EnvironmentId, boolean>();

/**
 * Whether Teams is configured on an environment, for entry points such as the command palette and
 * settings search. False until the environment answers, and while it can't.
 */
export function useTeamsConfigured(environmentId: EnvironmentId | null): boolean {
  const getStatus = useAtomCommand(serverEnvironment.getAccountStatus, { reportFailure: false });
  const [, answered] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (environmentId === null || configuredByEnvironment.has(environmentId)) return;
    let current = true;
    void getStatus({ environmentId, input: {} }).then((result) => {
      if (result._tag !== "Success") return;
      configuredByEnvironment.set(environmentId, result.value.configured);
      if (current) answered();
    });
    return () => {
      current = false;
    };
  }, [environmentId, getStatus]);
  return environmentId !== null && configuredByEnvironment.get(environmentId) === true;
}
