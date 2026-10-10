import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, TeamProjectSkill } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export interface ProjectTeamSkills {
  readonly teamName: string;
  readonly skills: readonly TeamProjectSkill[];
  /** Why the skills that are on couldn't be checked; the next send fails until they can be. */
  readonly problem: string | null;
}

/**
 * The skills the signed-in user turned on for a project, as the server checks them now. Read again
 * when the project changes, after each message is sent, and when the campus account changes. The
 * server decides at each send; this only shows what that will be.
 */
export function useProjectTeamSkills(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  sentMessages: number,
): ProjectTeamSkills | null {
  const request = useAtomCommand(serverEnvironment.teamProjects, { reportFailure: false });
  const [accountChanges, setAccountChanges] = useState(0);
  const [state, setState] = useState<{ key: string; value: ProjectTeamSkills | null } | null>(null);
  const key = environmentId && projectId ? `${environmentId}:${projectId}` : null;
  // Read again whenever the project, the thread's sent messages, or the account changes.
  const refresh = key === null ? null : `${key}\n${sentMessages}\n${accountChanges}`;
  useEffect(() => {
    const changed = () => setAccountChanges((count) => count + 1);
    window.addEventListener("tritonai-account-changed", changed);
    return () => window.removeEventListener("tritonai-account-changed", changed);
  }, []);
  useEffect(() => {
    if (!environmentId || !projectId || refresh === null) return;
    const key = refresh.slice(0, refresh.indexOf("\n"));
    let current = true;
    void request({ environmentId, input: { action: "skill-enabled", projectId } }).then(
      (result) => {
        if (!current) return;
        if (result._tag === "Success")
          return setState({
            key,
            value: {
              teamName: result.value.projects[0]?.teamName ?? "your team",
              skills: result.value.enabledSkills ?? [],
              problem: result.value.problem ?? null,
            },
          });
        const cause = squashAtomCommandFailure(result) as { code?: unknown; message?: unknown };
        // Unlinked projects and signed-out accounts have no team skills to show; a team that
        // can't be checked, or whose folder moved, stops sends in this project.
        setState({
          key,
          value:
            (cause.code === "unavailable" || cause.code === "conflict") &&
            typeof cause.message === "string"
              ? { teamName: "your team", skills: [], problem: cause.message }
              : null,
        });
      },
    );
    return () => {
      current = false;
    };
  }, [environmentId, projectId, refresh, request]);
  return state?.key === key ? state.value : null;
}

/** Opens Skills settings scoped to this thread's project. */
export function ManageTeamSkillsButton({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const groups = useSettingsProjectGroups();
  const project = groups.find((group) =>
    group.memberProjects.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    ),
  )?.projectKey;
  return (
    <Button
      size="xs"
      variant="outline"
      render={<Link to="/settings/skills" search={project ? { project } : {}} />}
    >
      Manage
    </Button>
  );
}
