import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { TeamsPage } from "../components/teams/TeamsPage";

/** A project to link, preselected in each team's link form, as opened from the command palette. */
export interface TeamsSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

export const Route = createFileRoute("/teams")({
  validateSearch: (raw: Record<string, unknown>): TeamsSearch => {
    const environmentId =
      typeof raw.environmentId === "string" && raw.environmentId
        ? (raw.environmentId as EnvironmentId)
        : undefined;
    return {
      ...(environmentId ? { environmentId } : {}),
      ...(environmentId && typeof raw.projectId === "string" && raw.projectId
        ? { projectId: raw.projectId as ProjectId }
        : {}),
    };
  },
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: TeamsRoute,
});

function TeamsRoute() {
  const { environmentId, projectId } = Route.useSearch();
  const linkProject = environmentId && projectId ? { environmentId, projectId } : null;
  return (
    <TeamsPage
      key={`${environmentId ?? ""}:${projectId ?? ""}`}
      linkProject={linkProject}
      {...(environmentId ? { initialEnvironmentId: environmentId } : {})}
    />
  );
}
