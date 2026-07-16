import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discardProviderSkillInstallRollback, installSkillBundle } from "./installProviderSkill.ts";

const skillMarkdown = (name: string, marker: string) =>
  `---\nname: ${name}\ndescription: Test skill.\n---\n\n${marker}\n`;

const bundle = (name: string, marker: string) => ({
  version: 1 as const,
  skillId: name,
  files: [{ path: "SKILL.md", content: skillMarkdown(name, marker) }],
});

describe("managed skill install ownership", () => {
  it.effect("does not replace an Installer-owned skill from a valid manifest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "managed-skill-install-test-" });
      const skillsDirectory = path.join(root, "skills");
      const skillDirectory = path.join(skillsDirectory, "secure-skill");
      const skillPath = path.join(skillDirectory, "SKILL.md");
      const original = skillMarkdown("secure-skill", "installer-owned");
      yield* fs.makeDirectory(skillDirectory, { recursive: true });
      yield* fs.writeFileString(skillPath, original);
      yield* fs.writeFileString(
        path.join(skillsDirectory, ".tritonai-managed-skills.json"),
        '{"version":1,"kind":"tritonai-secure","skills":["secure-skill"]}',
      );

      const error = yield* installSkillBundle({
        bundle: bundle("secure-skill", "untrusted-replacement"),
        skillsDirectory,
      }).pipe(Effect.flip);

      expect(error.message).toContain("managed by the TritonAI Installer");
      expect(yield* fs.readFileString(skillPath)).toBe(original);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not create a missing Installer-owned skill from a valid manifest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "managed-skill-install-test-" });
      const skillsDirectory = path.join(root, "skills");
      const skillDirectory = path.join(skillsDirectory, "secure-skill");
      yield* fs.makeDirectory(skillsDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillsDirectory, ".tritonai-managed-skills.json"),
        '{"version":1,"kind":"tritonai-secure","skills":["secure-skill"]}',
      );

      const error = yield* installSkillBundle({
        bundle: bundle("secure-skill", "untrusted-content"),
        skillsDirectory,
      }).pipe(Effect.flip);

      expect(error.message).toContain("managed by the TritonAI Installer");
      expect(yield* fs.exists(skillDirectory)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not refresh an existing skill when ownership is invalid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "managed-skill-install-test-" });
      const skillsDirectory = path.join(root, "skills");
      const skillDirectory = path.join(skillsDirectory, "local-skill");
      const skillPath = path.join(skillDirectory, "SKILL.md");
      const original = skillMarkdown("local-skill", "original");
      yield* fs.makeDirectory(skillDirectory, { recursive: true });
      yield* fs.writeFileString(skillPath, original);
      yield* fs.writeFileString(
        path.join(skillsDirectory, ".tritonai-managed-skills.json"),
        "not-json",
      );

      const error = yield* installSkillBundle({
        bundle: bundle("local-skill", "replacement"),
        skillsDirectory,
      }).pipe(Effect.flip);

      expect(error.message).toContain("ownership cannot be verified");
      expect(yield* fs.readFileString(skillPath)).toBe(original);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to install through a symlinked skills directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const skillsDirectory = path.resolve("apps/server/src/provider/__fixtures__/skills-link");
      const externalTarget = path.resolve("apps/server/src/provider/__fixtures__/skills-target");

      const error = yield* installSkillBundle({
        bundle: bundle("escaped-skill", "payload"),
        skillsDirectory,
      }).pipe(Effect.flip);

      expect(error.message).toContain("symlinked destination path");
      expect(yield* fs.exists(path.join(externalTarget, "escaped-skill"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refreshes an unmanaged same-name skill when ownership is known", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "managed-skill-install-test-" });
      const skillsDirectory = path.join(root, "skills");
      const skillDirectory = path.join(skillsDirectory, "local-skill");
      const skillPath = path.join(skillDirectory, "SKILL.md");
      yield* fs.makeDirectory(skillDirectory, { recursive: true });
      yield* fs.writeFileString(skillPath, skillMarkdown("local-skill", "original"));
      yield* fs.writeFileString(
        path.join(skillsDirectory, ".tritonai-managed-skills.json"),
        '{"version":1,"kind":"tritonai-secure","skills":["secure-skill"]}',
      );

      const result = yield* installSkillBundle({
        bundle: bundle("local-skill", "replacement"),
        skillsDirectory,
      });

      expect(yield* fs.readFileString(skillPath)).toContain("replacement");
      yield* discardProviderSkillInstallRollback(result.rollback);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
