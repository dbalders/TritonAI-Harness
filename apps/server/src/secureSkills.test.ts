import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  secureSkillDigest,
  synchronizeSecureSkillsFeed,
  validateSecureSkillFeed,
} from "./secureSkills.ts";

function skill(name: string, content: string) {
  const files = [{ path: "SKILL.md", content }];
  return { name, files, digest: secureSkillDigest(files) };
}

describe("secure skills feed", () => {
  it.effect("validates names, paths, sizes, and SHA-256 digests", () =>
    Effect.gen(function* () {
      const valid = {
        schemaVersion: 1 as const,
        revision: "revision-1",
        skills: [skill("managed-one", "---\nname: managed-one\n---\n")],
      };
      expect(yield* validateSecureSkillFeed(valid)).toEqual(valid);
      const error = yield* validateSecureSkillFeed({
        ...valid,
        skills: [{ ...valid.skills[0]!, digest: "0".repeat(64) }],
      }).pipe(Effect.flip);
      expect(error.message).toMatch(/digest verification/u);
    }),
  );

  it.effect("replaces only manifest-owned skills and preserves user skills", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "secure-skills-test-" });
        yield* fs.makeDirectory(path.join(root, "managed-old"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "managed-old/SKILL.md"), "old");
        yield* fs.makeDirectory(path.join(root, "user-skill"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "user-skill/SKILL.md"), "user");
        yield* fs.writeFileString(
          path.join(root, ".tritonai-managed-skills.json"),
          '{"version":1,"kind":"tritonai-secure","skills":["managed-old"]}',
        );

        const next = skill("managed-new", "---\nname: managed-new\n---\nnew");
        yield* synchronizeSecureSkillsFeed(
          { schemaVersion: 1, revision: "revision-2", skills: [next] },
          root,
        );

        expect(yield* fs.exists(path.join(root, "managed-old"))).toBe(false);
        expect(yield* fs.readFileString(path.join(root, "managed-new/SKILL.md"))).toContain("new");
        expect(yield* fs.readFileString(path.join(root, "user-skill/SKILL.md"))).toBe("user");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
