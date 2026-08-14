import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readSecureSkillsResponseBody,
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
        expect(
          (yield* fs.readDirectory(root)).filter(
            (name) =>
              name.startsWith(".secure-skills-stage.") || name.startsWith(".secure-skills-backup."),
          ),
        ).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects user-owned conflicts and managed symbolic links", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "secure-skills-safety-test-" });
        yield* fs.makeDirectory(path.join(root, "user-skill"), { recursive: true });
        const conflict = yield* synchronizeSecureSkillsFeed(
          {
            schemaVersion: 1,
            revision: "conflict",
            skills: [skill("user-skill", "user collision")],
          },
          root,
        ).pipe(Effect.flip);
        expect(conflict.message).toContain("user-owned skill");

        const external = yield* fs.makeTempDirectoryScoped({ prefix: "secure-skill-external-" });
        yield* fs.writeFileString(path.join(external, "SKILL.md"), "external");
        yield* fs.symlink(external, path.join(root, "managed-link"));
        yield* fs.writeFileString(
          path.join(root, ".tritonai-managed-skills.json"),
          '{"version":1,"kind":"tritonai-secure","skills":["managed-link"]}',
        );
        const linked = yield* synchronizeSecureSkillsFeed(
          { schemaVersion: 1, revision: "linked", skills: [] },
          root,
        ).pipe(Effect.flip);
        expect(linked.message).toContain("symbolic link");
        expect(yield* fs.readLink(path.join(root, "managed-link"))).toBe(external);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops reading a feed after the byte limit", () =>
    Effect.gen(function* () {
      const response = new Response(new Uint8Array(4 * 1024 * 1024 + 1));
      const error = yield* readSecureSkillsResponseBody(response).pipe(Effect.flip);
      expect(error.message).toContain("too large");
    }),
  );
});
