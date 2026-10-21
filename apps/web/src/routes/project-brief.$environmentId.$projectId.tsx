import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProjectBriefPage } from "../components/projectBrief/ProjectBriefPage";

export const Route = createFileRoute("/project-brief/$environmentId/$projectId")({
  validateSearch: (raw: Record<string, unknown>): { archive?: string } =>
    typeof raw.archive === "string" && raw.archive.length > 0 && raw.archive.length <= 200
      ? { archive: raw.archive }
      : {},
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ProjectBriefRoute,
});

function ProjectBriefRoute() {
  const { environmentId, projectId } = Route.useParams();
  const { archive } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ProjectBriefPage
      key={`${environmentId}:${projectId}`}
      environmentId={EnvironmentId.make(environmentId)}
      projectId={ProjectId.make(projectId)}
      archiveId={archive ?? null}
      onArchiveChange={(archiveId) => {
        void navigate({ search: archiveId ? { archive: archiveId } : {} });
      }}
    />
  );
}
