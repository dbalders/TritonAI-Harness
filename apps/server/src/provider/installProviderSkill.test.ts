import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

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
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "symlinked-skill-install-test-" });
      const skillsDirectory = path.join(root, "skills-link");
      const externalTarget = path.join(root, "skills-target");
      yield* fs.makeDirectory(externalTarget, { recursive: true });
      yield* fs.symlink(externalTarget, skillsDirectory);

      const error = yield* installSkillBundle({
        bundle: bundle("escaped-skill", "payload"),
        skillsDirectory,
      }).pipe(Effect.flip);

      expect(error.message).toContain("symlinked destination path");
      expect(yield* fs.exists(path.join(externalTarget, "escaped-skill"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to refresh through a symlinked skill directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "symlinked-skill-refresh-test-" });
      const skillsDirectory = path.join(root, "skills");
      const skillDirectory = path.join(skillsDirectory, "escaped-skill");
      const externalTarget = path.join(root, "external-target");
      yield* fs.makeDirectory(skillsDirectory, { recursive: true });
      yield* fs.makeDirectory(externalTarget, { recursive: true });
      yield* fs.symlink(externalTarget, skillDirectory);

      const error = yield* installSkillBundle({
        bundle: bundle("escaped-skill", "payload"),
        skillsDirectory,
      }).pipe(Effect.flip);

      expect(error.message).toContain("symlinked destination path");
      expect(yield* fs.exists(path.join(externalTarget, "SKILL.md"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when a destination symlink check cannot be completed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-inspection-failure-test-" });
      const skillsDirectory = path.join(root, "skills");
      yield* fs.makeDirectory(skillsDirectory, { recursive: true });
      const guardedFileSystem = {
        ...fs,
        readLink: (targetPath: string) =>
          targetPath === skillsDirectory
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readLink",
                  pathOrDescriptor: targetPath,
                  description: "Injected destination inspection failure.",
                }),
              )
            : fs.readLink(targetPath),
      } satisfies FileSystem.FileSystem;

      const error = yield* installSkillBundle({
        bundle: bundle("local-skill", "payload"),
        skillsDirectory,
      }).pipe(Effect.provideService(FileSystem.FileSystem, guardedFileSystem), Effect.flip);

      expect(error.message).toContain("Failed to inspect skill destination path");
      expect(yield* fs.exists(path.join(skillsDirectory, "local-skill"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not replace a destination created while the new path is claimed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-publish-swap-test-" });
      const skillsDirectory = path.join(root, "skills");
      const skillDirectory = path.join(skillsDirectory, "local-skill");
      yield* fs.makeDirectory(skillsDirectory, { recursive: true });
      let swapped = false;
      const swappingFileSystem = {
        ...fs,
        makeDirectory: (
          target: string,
          options?: Parameters<FileSystem.FileSystem["makeDirectory"]>[1],
        ) => {
          if (swapped || target !== skillDirectory) return fs.makeDirectory(target, options);
          swapped = true;
          return fs
            .makeDirectory(skillDirectory)
            .pipe(Effect.andThen(fs.makeDirectory(target, options)));
        },
      } satisfies FileSystem.FileSystem;

      const error = yield* installSkillBundle({
        bundle: bundle("local-skill", "payload"),
        skillsDirectory,
      }).pipe(Effect.provideService(FileSystem.FileSystem, swappingFileSystem), Effect.flip);

      expect(error.message).toContain("Failed to claim new skill destination");
      expect(yield* fs.exists(skillDirectory)).toBe(true);
      expect(yield* fs.exists(path.join(skillDirectory, "SKILL.md"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not follow an existing skill swapped to a symlink during refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-refresh-swap-test-" });
      const skillsDirectory = path.join(root, "skills");
      const skillDirectory = path.join(skillsDirectory, "local-skill");
      const externalTarget = path.join(root, "external-target");
      const markerPath = path.join(externalTarget, "marker.txt");
      yield* fs.makeDirectory(skillDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        skillMarkdown("local-skill", "original"),
      );
      yield* fs.makeDirectory(externalTarget, { recursive: true });
      yield* fs.writeFileString(markerPath, "keep");
      let swapped = false;
      const swappingFileSystem = {
        ...fs,
        rename: (from: string, to: string) => {
          if (swapped || from !== skillDirectory || !to.includes(".backup.")) {
            return fs.rename(from, to);
          }
          swapped = true;
          return fs
            .remove(skillDirectory, { recursive: true })
            .pipe(
              Effect.andThen(fs.symlink(externalTarget, skillDirectory)),
              Effect.andThen(fs.rename(from, to)),
            );
        },
      } satisfies FileSystem.FileSystem;

      const error = yield* installSkillBundle({
        bundle: bundle("local-skill", "replacement"),
        skillsDirectory,
      }).pipe(Effect.provideService(FileSystem.FileSystem, swappingFileSystem), Effect.flip);

      expect(error.message).toContain("symlinked destination path");
      expect(yield* fs.readFileString(markerPath)).toBe("keep");
      expect(yield* fs.exists(path.join(externalTarget, "SKILL.md"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not replace an existing skill swapped to another real directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-refresh-identity-test-" });
      const skillsDirectory = path.join(root, "skills");
      const skillDirectory = path.join(skillsDirectory, "local-skill");
      const substitutedDirectory = path.join(root, "substituted-skill");
      const markerPath = path.join(substitutedDirectory, "marker.txt");
      yield* fs.makeDirectory(skillDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        skillMarkdown("local-skill", "original"),
      );
      yield* fs.makeDirectory(substitutedDirectory, { recursive: true });
      yield* fs.writeFileString(markerPath, "keep");
      let swapped = false;
      const swappingFileSystem = {
        ...fs,
        rename: (from: string, to: string) => {
          if (swapped || from !== skillDirectory || !to.includes(".backup.")) {
            return fs.rename(from, to);
          }
          swapped = true;
          return fs
            .remove(skillDirectory, { recursive: true })
            .pipe(
              Effect.andThen(fs.rename(substitutedDirectory, skillDirectory)),
              Effect.andThen(fs.rename(from, to)),
            );
        },
      } satisfies FileSystem.FileSystem;

      const error = yield* installSkillBundle({
        bundle: bundle("local-skill", "replacement"),
        skillsDirectory,
      }).pipe(Effect.provideService(FileSystem.FileSystem, swappingFileSystem), Effect.flip);

      expect(error.message).toContain("identity changed");
      expect(yield* fs.readFileString(path.join(skillDirectory, "marker.txt"))).toBe("keep");
      expect(yield* fs.exists(path.join(skillDirectory, "SKILL.md"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a real skills directory under a symlinked parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "linked-skill-parent-test-" });
      const actualHome = path.join(root, "actual-home");
      const linkedHome = path.join(root, "linked-home");
      const skillsDirectory = path.join(linkedHome, "skills");
      yield* fs.makeDirectory(path.join(actualHome, "skills"), { recursive: true });
      yield* fs.symlink(actualHome, linkedHome);

      const result = yield* installSkillBundle({
        bundle: bundle("local-skill", "payload"),
        skillsDirectory,
      });

      expect(yield* fs.exists(path.join(actualHome, "skills", "local-skill", "SKILL.md"))).toBe(
        true,
      );
      yield* discardProviderSkillInstallRollback(result.rollback);
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
