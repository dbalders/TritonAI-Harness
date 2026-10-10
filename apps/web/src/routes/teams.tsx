import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { TeamsPage } from "../components/teams/TeamsPage";

/** A project to link, preselected in each team's link form, as opened from the command palette. */
export interface TeamsSearch {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

export const Route = createFileRoute("/teams")({
  validateSearch: (raw: Record<string, unknown>): TeamsSearch =>
    typeof raw.environmentId === "string" &&
    raw.environmentId &&
    typeof raw.projectId === "string" &&
    raw.projectId
      ? { environmentId: raw.environmentId as EnvironmentId, projectId: raw.projectId as ProjectId }
      : {},
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
      key={linkProject ? `${linkProject.environmentId}:${linkProject.projectId}` : ""}
      linkProject={linkProject}
    />
  );
}
