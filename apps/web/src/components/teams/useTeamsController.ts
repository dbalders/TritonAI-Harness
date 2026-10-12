import {
  type AccountLoginState,
  createTeamsControllerCache,
  pendingTeamInvitationCount,
  type TeamsController,
} from "@t3tools/client-runtime/state/server";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AccountProfile, EnvironmentId, TeamCommand, TeamsResult } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { accountKey } from "./teamMembershipReview";

const teamsControllers = createTeamsControllerCache();
// Account checks run on focus and renewal; the invitation count rereads teams at most this often.
const INVITATION_REFRESH_MS = 5 * 60 * 1000;
const noSubscription = () => () => {};

/** Sends one Teams command, failing with the service's error. */
export function useTeamsCommand(environmentId: EnvironmentId) {
  const request = useAtomCommand(serverEnvironment.teams, { reportFailure: false });
  return useCallback(
    async (input: TeamCommand): Promise<TeamsResult> => {
      const response = await request({ environmentId, input });
      if (response._tag === "Success") return response.value;
      const error = squashAtomCommandFailure(response);
      throw error instanceof Error ? error : new Error("Teams could not be reached.");
    },
    [environmentId, request],
  );
}

/** The teams controller every view of one campus account on an environment shares. */
export function useTeamsController(
  environmentId: EnvironmentId,
  profile: AccountProfile | null,
): TeamsController | null {
  const execute = useTeamsCommand(environmentId);
  const key = profile ? `${environmentId}\n${accountKey(profile)}` : null;
  return useMemo(() => (key === null ? null : teamsControllers(key, execute)), [execute, key]);
}

/** Pending invitations for the signed-in account, kept current by its existing account checks. */
export function usePendingTeamInvitationCount(
  environmentId: EnvironmentId,
  { account, checkedAt }: AccountLoginState,
) {
  const controller = useTeamsController(
    environmentId,
    account?.status === "signed-in" ? account.profile : null,
  );
  const count = useSyncExternalStore(controller?.subscribe ?? noSubscription, () =>
    controller ? pendingTeamInvitationCount(controller.getSnapshot()) : 0,
  );
  useEffect(() => controller?.activate(), [controller]);
  useEffect(() => {
    if (checkedAt !== null) void controller?.refreshList(INVITATION_REFRESH_MS);
  }, [checkedAt, controller]);
  return count;
}
