import type { EnvironmentId, ProjectId, TeamProjectSharing, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";
import { readEnvironmentSupportsTeamSharing } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { onUcsdAccountChanged } from "../../hooks/ucsdAccountEvents";

/**
 * Whether work in a project reaches its linked team's daily memory, as the server sees it now:
 * null when the project isn't linked to a team, or the campus account can't open it. Read again
 * when the project changes, after each message is sent, and when the campus account changes.
 */
export function useProjectTeamSharing(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  sentMessages: number,
): TeamProjectSharing | null {
  const request = useAtomCommand(serverEnvironment.teamProjects, { reportFailure: false });
  const [accountChanges, setAccountChanges] = useState(0);
  const [state, setState] = useState<{ key: string; value: TeamProjectSharing | null } | null>(
    null,
  );
  const key = environmentId && projectId ? `${environmentId}:${projectId}:${accountChanges}` : null;
  const refresh = key === null ? null : `${key}\n${sentMessages}`;
  useEffect(
    () =>
      onUcsdAccountChanged(environmentId, () => {
        setState(null);
        setAccountChanges((count) => count + 1);
      }),
    [environmentId],
  );
  useEffect(() => {
    if (!environmentId || !projectId || key === null || refresh === null) return;
    if (!readEnvironmentSupportsTeamSharing(environmentId)) return;
    let current = true;
    void request({ environmentId, input: { action: "sharing-status", projectId } }).then(
      (result) => {
        if (!current) return;
        if (result._tag === "Success")
          return setState({ key, value: result.value.sharing ?? null });
        const cause = squashAtomCommandFailure(result) as { code?: unknown; message?: unknown };
        // Only a definite answer (unlinked, no access, signed out) clears what is known. A check
        // that failed for this account and project keeps the team, marked as waiting, so the
        // thread can still be kept out of it.
        const settled =
          cause.code === "not_found" ||
          cause.code === "forbidden" ||
          cause.code === "sign_in_required";
        setState((previous) =>
          !settled && previous?.key === key && previous.value
            ? {
                key,
                value: {
                  ...previous.value,
                  state: "held",
                  message:
                    typeof cause.message === "string"
                      ? cause.message
                      : "Harness couldn't check sharing with your team. It will try again.",
                },
              }
            : { key, value: null },
        );
      },
    );
    return () => {
      current = false;
    };
  }, [environmentId, projectId, key, refresh, request]);
  return state?.key === key ? state.value : null;
}

/** Turns a thread's team sharing off (Don't share this thread) or back on. */
export function useSetThreadTeamSharing() {
  const mutate = useAtomCommand(threadEnvironment.setTeamSharing, { reportFailure: true });
  return useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId, shared: boolean) => {
      // Version skew: an older server doesn't understand the command, so it isn't sent.
      if (!readEnvironmentSupportsTeamSharing(environmentId)) return;
      void mutate({ environmentId, input: { threadId, shared } });
    },
    [mutate],
  );
}

/** What the composer says about a thread in a team workspace. */
export function threadTeamSharingNotice(sharing: TeamProjectSharing, threadShared: boolean) {
  if (!threadShared)
    return {
      variant: "info" as const,
      title: `Not shared with ${sharing.teamName}`,
      description:
        "You chose Don't share this thread, so its work stays out of the team's daily memory.",
      action: "Share this thread",
    };
  if (sharing.state === "held")
    return {
      variant: "warning" as const,
      title: `Sharing with ${sharing.teamName} is waiting`,
      description:
        sharing.message ?? "Your work here will be added to the team's memory once it can be.",
      action: "Don't share this thread",
    };
  return {
    variant: "info" as const,
    title: `Shared with ${sharing.teamName}`,
    description:
      "A summary of this thread's work is added to the team's daily memory, which every member can read.",
    action: "Don't share this thread",
  };
}
