import { createFileRoute } from "@tanstack/react-router";
import { HelpPage } from "../components/help/HelpPage";

export const Route = createFileRoute("/_chat/help")({
  component: HelpPage,
});
