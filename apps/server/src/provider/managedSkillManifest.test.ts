import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loadManagedSkillManifest } from "./managedSkillManifest.ts";

describe("loadManagedSkillManifest", () => {
  it.effect("fails closed for symlinked or malformed manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "managed-skills-test-" });
      const skillsDirectory = path.join(root, "skills");
      const manifestPath = path.join(skillsDirectory, ".tritonai-managed-skills.json");
      const outsideManifest = path.join(root, "outside.json");
      yield* fs.makeDirectory(skillsDirectory, { recursive: true });
      yield* fs.writeFileString(
        outsideManifest,
        '{"version":1,"kind":"tritonai-secure","skills":["spoofed"]}',
      );
      yield* fs.symlink(outsideManifest, manifestPath);

      expect((yield* loadManagedSkillManifest(skillsDirectory)).status).toBe("invalid");

      yield* fs.remove(manifestPath);
      yield* fs.writeFileString(manifestPath, '{"version":2,"skills":["unsafe"]}');
      expect((yield* loadManagedSkillManifest(skillsDirectory)).status).toBe("invalid");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
