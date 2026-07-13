// @effect-diagnostics nodeBuiltinImport:off
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as NodePath from "node:path";

import type { IntegrationPackage } from "./IntegrationRegistry.ts";
import { ApiKeyMcpFixtureProvider, SkillOnlyFixtureProvider } from "./FixtureProviders.ts";
import { MicrosoftGraphProvider } from "./MicrosoftGraphProvider.ts";
import apiKeyManifest from "./packages/authenticated-mcp-fixture/.tritonai-plugin/plugin.json" with { type: "json" };
import {
  apiKeyMcpFixtureInterface,
  apiKeyMcpFixtureSkill,
} from "./packages/authenticated-mcp-fixture/skillAssets.ts";
import microsoftManifest from "./packages/microsoft-365/.tritonai-plugin/plugin.json" with { type: "json" };
import {
  calendarInterface,
  calendarSkill,
  mailInterface,
  mailSkill,
} from "./packages/microsoft-365/skillAssets.ts";
import skillOnlyManifest from "./packages/skill-only-fixture/.tritonai-plugin/plugin.json" with { type: "json" };
import {
  skillOnlyFixtureInterface,
  skillOnlyFixtureSkill,
} from "./packages/skill-only-fixture/skillAssets.ts";
import { validateIntegrationManifest } from "./manifest.ts";

function packageRoot(id: string): string {
  return NodePath.join(import.meta.dirname, "packages", id);
}

export function makeBuiltinIntegrations(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): ReadonlyArray<IntegrationPackage> {
  return [
    {
      manifest: validateIntegrationManifest(microsoftManifest),
      provider: new MicrosoftGraphProvider(secrets),
      sourceRoot: packageRoot("microsoft-365"),
      bundledFiles: {
        ".tritonai-plugin/plugin.json": `${JSON.stringify(microsoftManifest, null, 2)}\n`,
        "skills/microsoft-365-mail/SKILL.md": mailSkill,
        "skills/microsoft-365-mail/agents/openai.yaml": mailInterface,
        "skills/microsoft-365-calendar/SKILL.md": calendarSkill,
        "skills/microsoft-365-calendar/agents/openai.yaml": calendarInterface,
      },
    },
    {
      manifest: validateIntegrationManifest(skillOnlyManifest),
      provider: new SkillOnlyFixtureProvider(),
      sourceRoot: packageRoot("skill-only-fixture"),
      bundledFiles: {
        ".tritonai-plugin/plugin.json": `${JSON.stringify(skillOnlyManifest, null, 2)}\n`,
        "skills/skill-only-fixture/SKILL.md": skillOnlyFixtureSkill,
        "skills/skill-only-fixture/agents/openai.yaml": skillOnlyFixtureInterface,
      },
    },
    {
      manifest: validateIntegrationManifest(apiKeyManifest),
      provider: new ApiKeyMcpFixtureProvider(secrets),
      sourceRoot: packageRoot("authenticated-mcp-fixture"),
      bundledFiles: {
        ".tritonai-plugin/plugin.json": `${JSON.stringify(apiKeyManifest, null, 2)}\n`,
        "skills/authenticated-mcp-fixture/SKILL.md": apiKeyMcpFixtureSkill,
        "skills/authenticated-mcp-fixture/agents/openai.yaml": apiKeyMcpFixtureInterface,
      },
    },
  ];
}
