import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  installMemorySkill,
  memorySkillName,
  removeMemorySkill,
  renderMemorySkill,
} from "./memoryVault.ts";

it.layer(NodeServices.layer)("memory skills", (it) => {
  it.effect("keeps both vaults available in a shared Codex home when one is disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tritonai-shared-memory-test-" });
      const skillsDirectory = path.join(root, "codex", "skills");
      const vaults = [
        path.join(root, ".tritonai-harness", "memory", "general"),
        path.join(root, ".tritonai-harness-nightly", "memory", "general"),
      ];
      yield* Effect.all(
        vaults.map((vaultPath) =>
          installMemorySkill({
            skillsDirectory,
            vaultPath,
            contents: renderMemorySkill({
              vaultPath,
              sessionsPath: path.join(root, "codex", "sessions"),
            }),
          }),
        ),
        { concurrency: "unbounded" },
      );

      assert.lengthOf(yield* fs.readDirectory(skillsDirectory), 2);
      for (const vaultPath of vaults) {
        const contents = yield* fs.readFileString(
          path.join(skillsDirectory, memorySkillName(vaultPath), "SKILL.md"),
        );
        assert.include(contents, `\`${vaultPath}\``);
      }
      const stableVault = vaults[0]!;
      const nightlyVault = vaults[1]!;
      const nightlySkill = path.join(skillsDirectory, memorySkillName(nightlyVault), "SKILL.md");
      const nightlyBefore = yield* fs.readFileString(nightlySkill);
      assert.isTrue(yield* removeMemorySkill({ skillsDirectory, vaultPath: stableVault }));
      assert.isFalse(yield* fs.exists(path.join(skillsDirectory, memorySkillName(stableVault))));
      assert.strictEqual(yield* fs.readFileString(nightlySkill), nightlyBefore);
    }),
  );

  it.effect("preserves a same-named skill belonging to another owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tritonai-memory-owner-test-" });
      const skillsDirectory = path.join(root, "skills");
      const vaultPath = path.join(root, "memory", "general");
      const skillFile = path.join(skillsDirectory, memorySkillName(vaultPath), "SKILL.md");
      const existing = renderMemorySkill({
        vaultPath: path.join(root, "other-vault"),
        sessionsPath: root,
      });
      yield* fs.makeDirectory(path.dirname(skillFile), { recursive: true });
      yield* fs.writeFileString(skillFile, existing);

      assert.strictEqual(
        yield* installMemorySkill({
          skillsDirectory,
          vaultPath,
          contents: renderMemorySkill({ vaultPath, sessionsPath: root }),
        }),
        "user-owned",
      );
      assert.isFalse(yield* removeMemorySkill({ skillsDirectory, vaultPath }));
      assert.strictEqual(yield* fs.readFileString(skillFile), existing);
    }),
  );
});
