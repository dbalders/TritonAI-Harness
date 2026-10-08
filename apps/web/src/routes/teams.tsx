import { createFileRoute, redirect } from "@tanstack/react-router";
import { TeamsPage } from "../components/teams/TeamsPage";
export const Route = createFileRoute("/teams")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: TeamsPage,
});
