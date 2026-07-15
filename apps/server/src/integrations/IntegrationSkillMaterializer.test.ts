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

  it("does not recopy an unchanged active skill set", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-noop-"));
    const packageRoot = NodePath.join(root, "package");
    const home = NodePath.join(root, "home");
    const target = NodePath.join(home, "skills", "fixture-reader");
    try {
      await NodeFSP.mkdir(NodePath.join(packageRoot, "skills", "fixture-reader"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, "skills", "fixture-reader", "SKILL.md"),
        "---\nname: fixture-reader\ndescription: Fixture.\n---\n",
      );
      const materializer = new CodexIntegrationSkillMaterializer([home]);
      const active = {
        integrationId: "fixture",
        packageRoot,
        activeSkills: ["fixture-reader"],
      };

      await materializer.sync(active);
      const firstInode = (await NodeFSP.stat(target)).ino;
      await materializer.sync({ ...active, activeSkills: [...active.activeSkills] });

      expect((await NodeFSP.stat(target)).ino).toBe(firstInode);
      await materializer.sync({ integrationId: "fixture", packageRoot: null, activeSkills: [] });
      await expect(NodeFSP.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to replace a matching but unmanaged skill target symlink", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-skill-target-symlink-"),
    );
    const packageRoot = NodePath.join(root, "package");
    const source = NodePath.join(packageRoot, "skills", "fixture-reader");
    const home = NodePath.join(root, "home");
    const target = NodePath.join(home, "skills", "fixture-reader");
    const external = NodePath.join(root, "external-skill");
    const skillContent = "---\nname: fixture-reader\ndescription: Fixture.\n---\ncontained\n";
    const active = {
      integrationId: "fixture",
      packageRoot,
      activeSkills: ["fixture-reader"],
    };
    try {
      await NodeFSP.mkdir(source, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(source, "SKILL.md"), skillContent);
      await NodeFSP.cp(source, external, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(external, ".tritonai-integration-skill.json"),
        JSON.stringify({ version: 1, integrationId: "fixture", skill: "fixture-reader" }),
      );
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.symlink(external, target);

      const materializer = new CodexIntegrationSkillMaterializer([home]);
      await expect(materializer.sync(active)).rejects.toThrow(
        /unmanaged Codex skill fixture-reader/u,
      );

      const targetEntry = await NodeFSP.lstat(target);
      expect(targetEntry.isSymbolicLink()).toBe(true);
      expect(await NodeFSP.readFile(NodePath.join(target, "SKILL.md"), "utf8")).toBe(skillContent);

      await materializer.sync({ integrationId: "fixture", packageRoot: null, activeSkills: [] });
      expect((await NodeFSP.lstat(target)).isSymbolicLink()).toBe(true);
      await expect(NodeFSP.access(external)).resolves.toBeUndefined();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("repairs missing or changed managed skills and follows package content updates", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-repair-"));
    const packageRoot = NodePath.join(root, "package");
    const home = NodePath.join(root, "home");
    const source = NodePath.join(packageRoot, "skills", "fixture-reader", "SKILL.md");
    const target = NodePath.join(home, "skills", "fixture-reader", "SKILL.md");
    const active = {
      integrationId: "fixture",
      packageRoot,
      activeSkills: ["fixture-reader"],
    };
    try {
      await NodeFSP.mkdir(NodePath.dirname(source), { recursive: true });
      await NodeFSP.writeFile(
        source,
        "---\nname: fixture-reader\ndescription: Fixture.\n---\noriginal\n",
      );
      const materializer = new CodexIntegrationSkillMaterializer([home]);
      await materializer.sync(active);

      await NodeFSP.writeFile(target, "externally modified\n");
      await materializer.sync(active);
      expect(await NodeFSP.readFile(target, "utf8")).toContain("original");

      await NodeFSP.writeFile(
        source,
        "---\nname: fixture-reader\ndescription: Fixture.\n---\nupdated\n",
      );
      await materializer.sync(active);
      expect(await NodeFSP.readFile(target, "utf8")).toContain("updated");

      await NodeFSP.rm(NodePath.dirname(target), { recursive: true });
      await materializer.sync(active);
      expect(await NodeFSP.readFile(target, "utf8")).toContain("updated");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("prunes skills owned by plugins that are no longer in the catalog", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-catalog-"));
    const home = NodePath.join(root, "home");
    const skillsRoot = NodePath.join(home, "skills");
    const markerName = ".tritonai-integration-skill.json";
    const makeSkill = async (name: string, integrationId?: string) => {
      const target = NodePath.join(skillsRoot, name);
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, "SKILL.md"), `---\nname: ${name}\n---\n`);
      if (integrationId) {
        await NodeFSP.writeFile(
          NodePath.join(target, markerName),
          JSON.stringify({ version: 1, integrationId, skill: name }),
        );
      }
      return target;
    };
    try {
      const active = await makeSkill("active-reader", "active-plugin");
      const retired = await makeSkill("retired-reader", "retired-plugin");
      const unmanaged = await makeSkill("user-reader");
      const materializer = new CodexIntegrationSkillMaterializer([home]);

      await materializer.reconcileCatalog(new Set(["active-plugin"]));

      await expect(NodeFSP.access(active)).resolves.toBeUndefined();
      await expect(NodeFSP.access(retired)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.access(unmanaged)).resolves.toBeUndefined();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked Codex skills root without touching its target", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-symlinked-skills-root-"),
    );
    const home = NodePath.join(root, "home");
    const external = NodePath.join(root, "external-skills");
    const externalSkill = NodePath.join(external, "fixture-reader");
    try {
      await NodeFSP.mkdir(externalSkill, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(externalSkill, "SKILL.md"), "external\n");
      await NodeFSP.writeFile(
        NodePath.join(externalSkill, ".tritonai-integration-skill.json"),
        JSON.stringify({ version: 1, integrationId: "fixture", skill: "fixture-reader" }),
      );
      await NodeFSP.mkdir(home, { recursive: true });
      await NodeFSP.symlink(external, NodePath.join(home, "skills"));
      const materializer = new CodexIntegrationSkillMaterializer([home]);

      await expect(materializer.reconcileCatalog(new Set())).rejects.toThrow(
        /skills root must be a real directory/u,
      );
      await expect(
        materializer.sync({
          integrationId: "fixture",
          packageRoot: NodePath.join(root, "package"),
          activeSkills: ["fixture-reader"],
        }),
      ).rejects.toThrow(/skills root must be a real directory/u);
      expect(await NodeFSP.readFile(NodePath.join(externalSkill, "SKILL.md"), "utf8")).toBe(
        "external\n",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves skill directories with scalar ownership marker JSON", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-skill-scalar-marker-"),
    );
    const home = NodePath.join(root, "home");
    const skillsRoot = NodePath.join(home, "skills");
    const targets: Array<string> = [];
    try {
      for (const [index, marker] of [null, "user-owned", 1, []].entries()) {
        const target = NodePath.join(skillsRoot, `user-skill-${index}`);
        targets.push(target);
        await NodeFSP.mkdir(target, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(target, "SKILL.md"), "user-owned\n");
        await NodeFSP.writeFile(
          NodePath.join(target, ".tritonai-integration-skill.json"),
          JSON.stringify(marker),
        );
      }

      await new CodexIntegrationSkillMaterializer([home]).reconcileCatalog(new Set());

      for (const target of targets) {
        await expect(NodeFSP.access(target)).resolves.toBeUndefined();
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves directories whose ownership marker names a different skill", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-skill-marker-mismatch-"),
    );
    const home = NodePath.join(root, "home");
    const skillsRoot = NodePath.join(home, "skills");
    const makeMismatched = async (directory: string, integrationId: string) => {
      const target = NodePath.join(skillsRoot, directory);
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, "SKILL.md"), "user-owned\n");
      await NodeFSP.writeFile(
        NodePath.join(target, ".tritonai-integration-skill.json"),
        JSON.stringify({ version: 1, integrationId, skill: "different-skill" }),
      );
      return target;
    };
    try {
      const retired = await makeMismatched("retired-victim", "retired-plugin");
      const inactive = await makeMismatched("inactive-victim", "fixture");
      const materializer = new CodexIntegrationSkillMaterializer([home]);

      await materializer.reconcileCatalog(new Set(["fixture"]));
      await materializer.sync({ integrationId: "fixture", packageRoot: null, activeSkills: [] });

      await expect(NodeFSP.access(retired)).resolves.toBeUndefined();
      await expect(NodeFSP.access(inactive)).resolves.toBeUndefined();
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
