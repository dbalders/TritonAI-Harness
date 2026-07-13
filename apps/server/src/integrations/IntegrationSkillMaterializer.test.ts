// @effect-diagnostics nodeBuiltinImport:off
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CodexIntegrationSkillMaterializer,
  resolveIntegrationCodexHomes,
} from "./IntegrationSkillMaterializer.ts";

describe("integration Codex skill homes", () => {
  it("resolves the managed default and every configured Codex instance home", () => {
    const baseDir = NodePath.resolve("/tmp/tritonai-home-test");
    const codex = ProviderDriverKind.make("codex");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: codex,
          config: { homePath: NodePath.join(baseDir, "primary") },
        },
        [ProviderInstanceId.make("codex_work")]: {
          driver: codex,
          config: { homePath: NodePath.join(baseDir, "work") },
        },
      },
    };
    expect(resolveIntegrationCodexHomes(baseDir, settings)).toEqual([
      NodePath.join(baseDir, "primary"),
      NodePath.join(baseDir, "work"),
    ]);
    expect(resolveIntegrationCodexHomes(baseDir, DEFAULT_SERVER_SETTINGS)).toEqual([
      NodePath.join(baseDir, "codex"),
    ]);
  });

  it("removes owned skills from retired homes and materializes them in new homes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-homes-"));
    const packageRoot = NodePath.join(root, "package");
    const firstHome = NodePath.join(root, "first");
    const secondHome = NodePath.join(root, "second");
    const skillPath = (home: string) => NodePath.join(home, "skills", "fixture-reader", "SKILL.md");
    try {
      await NodeFSP.mkdir(NodePath.join(packageRoot, "skills", "fixture-reader"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, "skills", "fixture-reader", "SKILL.md"),
        "---\nname: fixture-reader\ndescription: Fixture.\n---\n",
      );
      const materializer = new CodexIntegrationSkillMaterializer([firstHome]);
      const active = {
        integrationId: "fixture",
        packageRoot,
        activeSkills: ["fixture-reader"],
      };
      await materializer.sync(active);
      expect(await NodeFSP.readFile(skillPath(firstHome), "utf8")).toContain("fixture-reader");

      await materializer.setCodexHomes([secondHome]);
      await materializer.sync(active);
      await expect(NodeFSP.access(skillPath(firstHome))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await NodeFSP.readFile(skillPath(secondHome), "utf8")).toContain("fixture-reader");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to replace an unmanaged Codex skill with the same declared name", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-collision-"));
    const packageRoot = NodePath.join(root, "package");
    const home = NodePath.join(root, "home");
    const target = NodePath.join(home, "skills", "fixture-reader");
    try {
      await NodeFSP.mkdir(NodePath.join(packageRoot, "skills", "fixture-reader"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, "skills", "fixture-reader", "SKILL.md"),
        "---\nname: fixture-reader\ndescription: Managed fixture.\n---\n",
      );
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(target, "SKILL.md"),
        "---\nname: fixture-reader\ndescription: User-owned fixture.\n---\n",
      );
      const materializer = new CodexIntegrationSkillMaterializer([home]);

      await expect(
        materializer.sync({
          integrationId: "fixture",
          packageRoot,
          activeSkills: ["fixture-reader"],
        }),
      ).rejects.toThrow(/unmanaged Codex skill fixture-reader/u);
      expect(await NodeFSP.readFile(NodePath.join(target, "SKILL.md"), "utf8")).toContain(
        "User-owned fixture",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves matching ownership markers that do not declare marker version 1", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-marker-"));
    const packageRoot = NodePath.join(root, "package");
    const home = NodePath.join(root, "home");
    const target = NodePath.join(home, "skills", "fixture-reader");
    const missingSkillTarget = NodePath.join(home, "skills", "fixture-missing-skill");
    try {
      await NodeFSP.mkdir(NodePath.join(packageRoot, "skills", "fixture-reader"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, "skills", "fixture-reader", "SKILL.md"),
        "---\nname: fixture-reader\ndescription: Managed fixture.\n---\n",
      );
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(target, "SKILL.md"),
        "---\nname: fixture-reader\ndescription: Existing fixture.\n---\n",
      );
      await NodeFSP.writeFile(
        NodePath.join(target, ".tritonai-integration-skill.json"),
        JSON.stringify({ integrationId: "fixture", skill: "fixture-reader" }),
      );
      await NodeFSP.mkdir(missingSkillTarget, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(missingSkillTarget, "SKILL.md"),
        "---\nname: fixture-missing-skill\ndescription: Existing fixture.\n---\n",
      );
      await NodeFSP.writeFile(
        NodePath.join(missingSkillTarget, ".tritonai-integration-skill.json"),
        JSON.stringify({ version: 1, integrationId: "fixture" }),
      );
      const materializer = new CodexIntegrationSkillMaterializer([home]);

      await materializer.sync({ integrationId: "fixture", packageRoot: null, activeSkills: [] });
      expect(await NodeFSP.readFile(NodePath.join(target, "SKILL.md"), "utf8")).toContain(
        "Existing fixture",
      );
      expect(
        await NodeFSP.readFile(NodePath.join(missingSkillTarget, "SKILL.md"), "utf8"),
      ).toContain("Existing fixture");
      await expect(
        materializer.sync({
          integrationId: "fixture",
          packageRoot,
          activeSkills: ["fixture-reader"],
        }),
      ).rejects.toThrow(/unmanaged Codex skill fixture-reader/u);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("removes interrupted skill swap directories without touching normal directories", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-swap-"));
    const packageRoot = NodePath.join(root, "package");
    const home = NodePath.join(root, "home");
    const skillsRoot = NodePath.join(home, "skills");
    const swapId = "11111111-1111-4111-8111-111111111111";
    const staging = NodePath.join(skillsRoot, `.fixture-reader.${swapId}.staging`);
    const backup = NodePath.join(skillsRoot, `fixture-reader.${swapId}.backup`);
    const normal = NodePath.join(skillsRoot, ".fixture-reader.not-a-uuid.staging");
    const unownedLookalike = NodePath.join(skillsRoot, `manual-reader.${swapId}.backup`);
    const marker = JSON.stringify({
      version: 1,
      integrationId: "fixture",
      skill: "fixture-reader",
    });
    try {
      await NodeFSP.mkdir(NodePath.join(packageRoot, "skills", "fixture-reader"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, "skills", "fixture-reader", "SKILL.md"),
        "---\nname: fixture-reader\ndescription: Managed fixture.\n---\n",
      );
      for (const directory of [staging, backup, normal]) {
        await NodeFSP.mkdir(directory, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(directory, ".tritonai-integration-skill.json"),
          marker,
        );
      }
      await NodeFSP.mkdir(unownedLookalike, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(unownedLookalike, "SKILL.md"), "manual skill\n");

      await new CodexIntegrationSkillMaterializer([home], { staleSwapAgeMs: 0 }).sync({
        integrationId: "fixture",
        packageRoot,
        activeSkills: ["fixture-reader"],
      });

      await expect(NodeFSP.access(staging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.access(backup)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.access(normal)).resolves.toBeUndefined();
      await expect(NodeFSP.access(unownedLookalike)).resolves.toBeUndefined();
      await expect(
        NodeFSP.access(NodePath.join(skillsRoot, "fixture-reader", "SKILL.md")),
      ).resolves.toBeUndefined();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("does not create a configured Codex home for inactive integrations", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-inactive-home-"));
    const missingHome = NodePath.join(root, "not-created");
    try {
      const materializer = new CodexIntegrationSkillMaterializer([missingHome]);
      await materializer.sync({
        integrationId: "fixture",
        packageRoot: null,
        activeSkills: [],
      });
      await expect(NodeFSP.access(missingHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
