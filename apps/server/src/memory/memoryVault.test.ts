import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  devicePaths,
  ensureGeneralVault,
  generalVaultPaths,
  installMemorySkill,
  type MemoryDevice,
  memorySkillName,
  registerMemoryDevice,
  removeMemorySkill,
  renderMemorySkill,
  writeGeneratedFile,
} from "./memoryVault.ts";

const device: MemoryDevice = {
  id: "3f2a9c1e-0000-4000-8000-000000000001",
  shortId: "3f2a",
  name: "MacBook Pro",
  label: "MacBook Pro (3f2a)",
};

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
              device,
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
        device,
      });
      yield* fs.makeDirectory(path.dirname(skillFile), { recursive: true });
      yield* fs.writeFileString(skillFile, existing);

      assert.strictEqual(
        yield* installMemorySkill({
          skillsDirectory,
          vaultPath,
          contents: renderMemorySkill({ vaultPath, sessionsPath: root, device }),
        }),
        "user-owned",
      );
      assert.isFalse(yield* removeMemorySkill({ skillsDirectory, vaultPath }));
      assert.strictEqual(yield* fs.readFileString(skillFile), existing);
    }),
  );
});

it.layer(NodeServices.layer)("memory vault", (it) => {
  it.effect("keeps a device's name and short code, and lengthens a code another device uses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tritonai-memory-device-test-" });
      const vault = generalVaultPaths(path, root);
      const register = (environmentId: string, computerName: string) =>
        registerMemoryDevice({
          vault,
          environmentId,
          computerName,
          platform: "darwin",
          nowIso: "2026-09-29T16:00:00.000Z",
        });

      const first = yield* register("3f2a9c1e-aaaa-4000-8000-000000000001", 'David\'s "Mac": Pro');
      assert.deepStrictEqual(first, {
        id: "3f2a9c1e-aaaa-4000-8000-000000000001",
        shortId: "3f2a",
        name: "David's Mac Pro",
        label: "David's Mac Pro (3f2a)",
      });
      // Renaming the computer does not rename the files it already wrote.
      assert.strictEqual((yield* register(first.id, "New Name")).label, first.label);

      const second = yield* register("3f2a77b0-bbbb-4000-8000-000000000002", "Office iMac");
      assert.strictEqual(second.shortId, "3f2a77");
      assert.strictEqual(second.label, "Office iMac (3f2a77)");
    }),
  );

  it.effect("saves a copy of a generated note someone edited before writing it again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tritonai-memory-edit-test-" });
      const vault = generalVaultPaths(path, root);
      const paths = devicePaths(path, vault, device);
      const filePath = path.join(vault.daily, "2026", "2026-09-28 MacBook Pro (3f2a).md");
      const recovered = path.join(
        vault.notes,
        "Recovered",
        "Daily",
        "2026",
        "2026-09-28 MacBook Pro (3f2a).md",
      );
      const write = (contents: string) =>
        writeGeneratedFile({ vault, device: paths, filePath, contents });

      yield* write("First summary.\n");
      yield* write("Second summary.\n");
      assert.isFalse(yield* fs.exists(recovered));

      yield* fs.writeFileString(filePath, "Second summary.\nMy own line.\n");
      yield* write("Third summary.\n");
      assert.strictEqual(yield* fs.readFileString(filePath), "Third summary.\n");
      assert.strictEqual(yield* fs.readFileString(recovered), "Second summary.\nMy own line.\n");

      // A file Harness never wrote is also someone else's.
      const foreign = path.join(vault.daily, "2026", "2026-09-27 MacBook Pro (3f2a).md");
      yield* fs.writeFileString(foreign, "Started by hand.\n");
      yield* writeGeneratedFile({
        vault,
        device: paths,
        filePath: foreign,
        contents: "Summary.\n",
      });
      assert.strictEqual(
        yield* fs.readFileString(
          path.join(vault.notes, "Recovered", "Daily", "2026", "2026-09-27 MacBook Pro (3f2a).md"),
        ),
        "Started by hand.\n",
      );
    }),
  );

  it.effect("keeps the vault guide current and moves a hand-written guide to Notes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "tritonai-memory-guide-test-" });
      const vault = generalVaultPaths(path, root);
      yield* fs.makeDirectory(vault.root, { recursive: true });
      yield* fs.writeFileString(vault.guide, "# My vault rules\n");

      yield* ensureGeneralVault(vault, device);
      const guide = yield* fs.readFileString(vault.guide);
      assert.include(guide, "Daily/2026/2026-09-29 MacBook Pro (3f2a).md");
      assert.strictEqual(
        yield* fs.readFileString(path.join(vault.notes, "Recovered", "AGENTS (previous).md")),
        "# My vault rules\n",
      );
      for (const directory of [
        vault.daily,
        vault.projects,
        path.join(vault.inbox, "3f2a", "processed"),
      ]) {
        assert.isTrue(yield* fs.exists(directory));
      }

      // Notes dropped straight into Inbox/ join this device's inbox.
      yield* fs.writeFileString(path.join(vault.inbox, "idea.md"), "Loose note.\n");
      yield* fs.writeFileString(path.join(vault.inbox, "3f2a", "idea.md"), "Already here.\n");
      yield* ensureGeneralVault(vault, device);
      assert.isFalse(yield* fs.exists(path.join(vault.inbox, "idea.md")));
      assert.strictEqual(
        yield* fs.readFileString(path.join(vault.inbox, "3f2a", "idea-2.md")),
        "Loose note.\n",
      );

      // A later run leaves its own current guide alone and moves nothing.
      yield* ensureGeneralVault(vault, device);
      assert.strictEqual(yield* fs.readFileString(vault.guide), guide);
      assert.isFalse(
        yield* fs.exists(path.join(vault.notes, "Recovered", "AGENTS (previous) 2.md")),
      );
    }),
  );
});
