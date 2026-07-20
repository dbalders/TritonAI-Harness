import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  ensureProviderSkillRemovalPathIsSafe,
  providerSkillRemovalIdentityMatches,
  removeProviderSkillFolder,
} from "./removeProviderSkill.ts";

describe("provider skill removal path safety", () => {
  it.effect("refuses to remove through a symlinked skills directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "symlinked-skill-remove-test-" });
      const homeDirectory = path.join(root, "home");
      const sharedSkillsDirectory = path.join(homeDirectory, "skills");
      const externalSkillsDirectory = path.join(root, "external-skills");
      const externalSkillDirectory = path.join(externalSkillsDirectory, "local-skill");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "local-skill");
      yield* fs.makeDirectory(homeDirectory, { recursive: true });
      yield* fs.makeDirectory(externalSkillDirectory, { recursive: true });
      yield* fs.symlink(externalSkillsDirectory, sharedSkillsDirectory);

      const error = yield* ensureProviderSkillRemovalPathIsSafe({
        sharedSkillsDirectory,
        skillDirectoryPath,
      }).pipe(Effect.flip);

      expect(error.message).toContain("managed Codex skills folder");
      expect(yield* fs.exists(externalSkillDirectory)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to remove a symlinked skill directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "symlinked-skill-remove-test-" });
      const sharedSkillsDirectory = path.join(root, "skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "local-skill");
      const externalSkillDirectory = path.join(root, "external-skill");
      const markerPath = path.join(externalSkillDirectory, "marker.txt");
      yield* fs.makeDirectory(sharedSkillsDirectory, { recursive: true });
      yield* fs.makeDirectory(externalSkillDirectory, { recursive: true });
      yield* fs.writeFileString(markerPath, "keep");
      yield* fs.symlink(externalSkillDirectory, skillDirectoryPath);

      const error = yield* ensureProviderSkillRemovalPathIsSafe({
        sharedSkillsDirectory,
        skillDirectoryPath,
      }).pipe(Effect.flip);

      expect(error.message).toContain("managed Codex skills folder");
      expect(yield* fs.readFileString(markerPath)).toBe("keep");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed when a removal symlink check cannot be completed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-removal-inspection-test-" });
      const sharedSkillsDirectory = path.join(root, "skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "local-skill");
      const markerPath = path.join(skillDirectoryPath, "marker.txt");
      yield* fs.makeDirectory(skillDirectoryPath, { recursive: true });
      yield* fs.writeFileString(markerPath, "keep");
      const guardedFileSystem = {
        ...fs,
        readLink: (targetPath: string) =>
          targetPath === sharedSkillsDirectory
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readLink",
                  pathOrDescriptor: targetPath,
                  description: "Injected removal inspection failure.",
                }),
              )
            : fs.readLink(targetPath),
      } satisfies FileSystem.FileSystem;

      const error = yield* ensureProviderSkillRemovalPathIsSafe({
        sharedSkillsDirectory,
        skillDirectoryPath,
      }).pipe(Effect.provideService(FileSystem.FileSystem, guardedFileSystem), Effect.flip);

      expect(error.message).toContain("Failed to inspect skill removal path");
      expect(yield* fs.readFileString(markerPath)).toBe("keep");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not follow a skill directory swapped to a symlink during removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-removal-swap-test-" });
      const sharedSkillsDirectory = path.join(root, "skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "local-skill");
      const externalSkillDirectory = path.join(root, "external-skill");
      const markerPath = path.join(externalSkillDirectory, "marker.txt");
      yield* fs.makeDirectory(skillDirectoryPath, { recursive: true });
      yield* fs.writeFileString(path.join(skillDirectoryPath, "SKILL.md"), "local skill");
      yield* fs.makeDirectory(externalSkillDirectory, { recursive: true });
      yield* fs.writeFileString(markerPath, "keep");
      yield* ensureProviderSkillRemovalPathIsSafe({
        sharedSkillsDirectory,
        skillDirectoryPath,
      });

      let swapped = false;
      const swappingFileSystem = {
        ...fs,
        rename: (from: string, to: string) => {
          if (swapped || from !== skillDirectoryPath) return fs.rename(from, to);
          swapped = true;
          return fs
            .remove(skillDirectoryPath, { recursive: true })
            .pipe(
              Effect.andThen(fs.symlink(externalSkillDirectory, skillDirectoryPath)),
              Effect.andThen(fs.rename(from, to)),
            );
        },
      } satisfies FileSystem.FileSystem;

      const error = yield* removeProviderSkillFolder({
        sharedSkillsDirectory,
        skillDirectoryPath,
      }).pipe(Effect.provideService(FileSystem.FileSystem, swappingFileSystem), Effect.flip);

      expect(error.message).toContain("changed during removal");
      expect(yield* fs.readFileString(markerPath)).toBe("keep");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a managed skills directory replaced after identity capture", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skills-parent-swap-test-" });
      const sharedSkillsDirectory = path.join(root, "skills");
      const originalSkillsDirectory = path.join(root, "original-skills");
      const externalSkillsDirectory = path.join(root, "external-skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "local-skill");
      const externalSkillDirectory = path.join(externalSkillsDirectory, "local-skill");
      const externalMarkerPath = path.join(externalSkillDirectory, "marker.txt");
      yield* fs.makeDirectory(skillDirectoryPath, { recursive: true });
      yield* fs.writeFileString(path.join(skillDirectoryPath, "SKILL.md"), "original skill");
      yield* fs.makeDirectory(externalSkillDirectory, { recursive: true });
      yield* fs.writeFileString(externalMarkerPath, "keep");
      const expectedIdentity = yield* ensureProviderSkillRemovalPathIsSafe({
        sharedSkillsDirectory,
        skillDirectoryPath,
      });
      expect(
        yield* providerSkillRemovalIdentityMatches(
          sharedSkillsDirectory,
          skillDirectoryPath,
          expectedIdentity!,
        ),
      ).toBe(true);

      yield* fs.rename(sharedSkillsDirectory, originalSkillsDirectory);
      yield* fs.symlink(externalSkillsDirectory, sharedSkillsDirectory);
      expect(
        yield* providerSkillRemovalIdentityMatches(
          sharedSkillsDirectory,
          skillDirectoryPath,
          expectedIdentity!,
        ),
      ).toBe(false);
      const error = yield* removeProviderSkillFolder({
        sharedSkillsDirectory,
        skillDirectoryPath,
        expectedIdentity: expectedIdentity!,
      }).pipe(Effect.flip);

      expect(error.message).toContain("changed during removal");
      expect(yield* fs.readFileString(externalMarkerPath)).toBe("keep");
      expect(yield* fs.exists(externalSkillDirectory)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retains quarantine instead of restoring a partially deleted skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skill-removal-failure-test-" });
      const sharedSkillsDirectory = path.join(root, "skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "local-skill");
      const deletedMarkerPath = path.join(skillDirectoryPath, "deleted.txt");
      const preservedMarkerPath = path.join(skillDirectoryPath, "preserved.txt");
      yield* fs.makeDirectory(skillDirectoryPath, { recursive: true });
      yield* fs.writeFileString(deletedMarkerPath, "delete before failure");
      yield* fs.writeFileString(preservedMarkerPath, "keep for recovery");

      let failedDeletion = false;
      const failingFileSystem = {
        ...fs,
        remove: (targetPath, options) => {
          const isQuarantinedSkill =
            path.basename(targetPath) === "skill" &&
            path.basename(path.dirname(targetPath)).startsWith(".local-skill.remove.");
          if (!failedDeletion && isQuarantinedSkill && options?.recursive === true) {
            failedDeletion = true;
            return fs.remove(path.join(targetPath, "deleted.txt")).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "remove",
                    pathOrDescriptor: targetPath,
                    description: "Injected partial quarantined skill deletion failure.",
                  }),
                ),
              ),
            );
          }
          return fs.remove(targetPath, options);
        },
      } satisfies FileSystem.FileSystem;

      const error = yield* removeProviderSkillFolder({
        sharedSkillsDirectory,
        skillDirectoryPath,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

      expect(error.message).toContain("Failed to remove skill folder");
      expect(yield* fs.exists(skillDirectoryPath)).toBe(false);
      const [quarantineName] = yield* fs.readDirectory(sharedSkillsDirectory);
      expect(quarantineName).toMatch(/^\.local-skill\.remove\./);
      expect(
        yield* fs.readFileString(
          path.join(sharedSkillsDirectory, quarantineName!, "skill", "preserved.txt"),
        ),
      ).toBe("keep for recovery");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a real skill directory under a symlinked parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "linked-skill-remove-test-" });
      const actualHome = path.join(root, "actual-home");
      const linkedHome = path.join(root, "linked-home");
      const sharedSkillsDirectory = path.join(linkedHome, "skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "local-skill");
      yield* fs.makeDirectory(path.join(actualHome, "skills", "local-skill"), { recursive: true });
      yield* fs.symlink(actualHome, linkedHome);

      yield* ensureProviderSkillRemovalPathIsSafe({
        sharedSkillsDirectory,
        skillDirectoryPath,
      });

      expect(yield* fs.exists(skillDirectoryPath)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("allows cleanup when the skill directory is already missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "missing-skill-remove-test-" });
      const sharedSkillsDirectory = path.join(root, "skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "missing-skill");
      yield* fs.makeDirectory(sharedSkillsDirectory, { recursive: true });

      yield* ensureProviderSkillRemovalPathIsSafe({
        sharedSkillsDirectory,
        skillDirectoryPath,
      });
      yield* removeProviderSkillFolder({ skillDirectoryPath });

      expect(yield* fs.exists(skillDirectoryPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves a skill that appears after expected absence was captured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "appeared-skill-remove-test-" });
      const sharedSkillsDirectory = path.join(root, "skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "appeared-skill");
      const markerPath = path.join(skillDirectoryPath, "marker.txt");
      yield* fs.makeDirectory(sharedSkillsDirectory, { recursive: true });
      const expectedIdentity = yield* ensureProviderSkillRemovalPathIsSafe({
        sharedSkillsDirectory,
        skillDirectoryPath,
      });
      expect(expectedIdentity).toBeNull();

      yield* fs.makeDirectory(skillDirectoryPath);
      yield* fs.writeFileString(markerPath, "keep");
      const error = yield* removeProviderSkillFolder({
        sharedSkillsDirectory,
        skillDirectoryPath,
        expectedIdentity,
      }).pipe(Effect.flip);

      expect(error.message).toContain("appeared after removal began");
      expect(yield* fs.readFileString(markerPath)).toBe("keep");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not mistake a dangling skill symlink for an absent path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "dangling-skill-remove-test-" });
      const sharedSkillsDirectory = path.join(root, "skills");
      const skillDirectoryPath = path.join(sharedSkillsDirectory, "dangling-skill");
      const missingTarget = path.join(root, "missing-target");
      yield* fs.makeDirectory(sharedSkillsDirectory, { recursive: true });
      yield* fs.symlink(missingTarget, skillDirectoryPath);

      const error = yield* removeProviderSkillFolder({
        sharedSkillsDirectory,
        skillDirectoryPath,
        expectedIdentity: null,
      }).pipe(Effect.flip);

      expect(error.message).toContain("appeared after removal began");
      expect(yield* fs.readLink(skillDirectoryPath)).toBe(missingTarget);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("allows cleanup when the entire skills directory is already missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "missing-skills-remove-test-" });
      const skillDirectoryPath = path.join(root, "skills", "missing-skill");

      yield* removeProviderSkillFolder({ skillDirectoryPath });

      expect(yield* fs.exists(path.join(root, "skills"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
