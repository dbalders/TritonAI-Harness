import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loadManagedSkillManifest } from "./managedSkillManifest.ts";

describe("loadManagedSkillManifest", () => {
  it.effect("loads, deduplicates, and sorts installer-owned secure skill names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const skillsDirectory = yield* fs.makeTempDirectory({ prefix: "managed-skills-test-" });
      yield* fs.writeFileString(
        path.join(skillsDirectory, ".tritonai-managed-skills.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          version: 1,
          kind: "tritonai-secure",
          skills: ["secure-review", "campus-deploy", "secure-review"],
        }),
      );

      const result = yield* loadManagedSkillManifest(skillsDirectory);
      expect(result).toEqual({
        skillNames: ["campus-deploy", "secure-review"],
        status: "valid",
      });
      yield* fs.remove(skillsDirectory, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves backward compatibility when the manifest is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const skillsDirectory = yield* fs.makeTempDirectory({ prefix: "managed-skills-test-" });
      expect(yield* loadManagedSkillManifest(skillsDirectory)).toEqual({
        skillNames: [],
        status: "absent",
      });
      yield* fs.remove(skillsDirectory, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
