import { createFileRoute } from "@tanstack/react-router";

import { BotSettings } from "../components/settings/BotSettings";

export const Route = createFileRoute("/settings/tritonai-bot")({
  component: BotSettings,
});
