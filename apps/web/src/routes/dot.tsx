import { createFileRoute } from "@tanstack/react-router";

import { DotPage } from "../components/dot/DotPage";

export const Route = createFileRoute("/dot")({
  component: DotPage,
});
