import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettingsPanel } from "../components/settings/SkillsSettings";

export const Route = createFileRoute("/settings/skills")({
  component: SkillsSettingsPanel,
});
