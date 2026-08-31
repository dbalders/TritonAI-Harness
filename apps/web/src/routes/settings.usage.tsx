import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/usage")({
  beforeLoad: () => {
    throw redirect({ to: "/usage", replace: true });
  },
});
