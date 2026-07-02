import { createFileRoute } from "@tanstack/react-router";

import { PluginsSettingsPanel } from "../components/settings/PluginsSettings";

export const Route = createFileRoute("/settings/plugins")({
  component: PluginsSettingsPanel,
});
