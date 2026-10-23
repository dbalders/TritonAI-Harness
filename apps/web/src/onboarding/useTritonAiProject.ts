import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef } from "react";
import { waitForProject } from "../firstRunOnboarding";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { useProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import {
  isTritonAiWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
} from "../tritonAiWorkspace";

/** Find the TritonAI folder's project, creating the folder on first use. */
export function useTritonAiProject(environmentId: EnvironmentId | null) {
  const projects = useProjects();
  const createProject = useAtomCommand(projectEnvironment.create, {
    label: "guided tour project create",
    reportFailure: false,
  });
  const existing = useMemo(
    () =>
      projects.find(
        (project) =>
          project.environmentId === environmentId && isTritonAiWorkspacePath(project.workspaceRoot),
      ) ?? null,
    [environmentId, projects],
  );
  // Remembers a project created here until the project list catches up, so a second
  // run never tries to create the folder again.
  const created = useRef<EnvironmentProject | null>(null);
  return useCallback(async (): Promise<EnvironmentProject | null> => {
    if (existing) return existing;
    if (created.current?.environmentId === environmentId) return created.current;
    if (!environmentId) return null;
    const workspacePath = resolveTritonAiFirstRunWorkspacePath();
    const projectId = newProjectId();
    const result = await createProject({
      environmentId,
      input: {
        projectId,
        title: inferProjectTitleFromPath(workspacePath) || "TritonAI",
        workspaceRoot: workspacePath,
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
      },
    });
    if (result._tag === "Failure") return null;
    created.current = await waitForProject({ environmentId, projectId, timeoutMs: 5_000 });
    return created.current;
  }, [createProject, environmentId, existing]);
}
