import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ensureProviderSkillRemovalPathIsSafe,
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
});
