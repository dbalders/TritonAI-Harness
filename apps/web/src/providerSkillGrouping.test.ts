import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  isProviderSkillMutationBlocked,
  isProviderSkillPublishable,
  type ProviderSkillRow,
} from "./providerSkillGrouping";

const provider = {
  instanceId: "codex" as ProviderInstanceId,
  driver: "codex",
} as ServerProvider;

function row(name: string): ProviderSkillRow {
  return {
    provider,
    skill: { name, path: `/tmp/skills/${name}/SKILL.md`, enabled: true },
  };
}

describe("groupProviderSkills", () => {
  it("blocks installation and removal while managed ownership is invalid or unknown", () => {
    expect(isProviderSkillMutationBlocked("invalid")).toBe(true);
    expect(isProviderSkillMutationBlocked("unknown")).toBe(true);
    expect(isProviderSkillMutationBlocked("absent")).toBe(false);
    expect(isProviderSkillMutationBlocked("valid")).toBe(false);
  });

  it("offers Commons submission only for local SKILL.md-backed skills", () => {
    expect(isProviderSkillPublishable(row("my-local-skill").skill)).toBe(true);
    expect(
      isProviderSkillPublishable({
        ...row("system-skill").skill,
        scope: "system",
      }),
    ).toBe(false);
    expect(
      isProviderSkillPublishable({
        ...row("plugin-skill").skill,
        path: "/tmp/.codex/plugins/example/skills/plugin-skill/SKILL.md",
      }),
    ).toBe(false);
  });
});
