import { createFileRoute, redirect } from "@tanstack/react-router";
import { ProjectHomePage } from "../components/projectHome/ProjectHomePage";

export const Route = createFileRoute("/project-home/$projectKey")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: ProjectHomeRoute,
});

function ProjectHomeRoute() {
  const { projectKey } = Route.useParams();
  return <ProjectHomePage key={projectKey} projectKey={projectKey} />;
}
