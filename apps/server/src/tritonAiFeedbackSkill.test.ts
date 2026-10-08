import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  runTritonAiFeedbackSkillSync,
  syncTritonAiFeedbackSkill,
  TritonAiFeedbackSkillSyncError,
} from "./tritonAiFeedbackSkill.ts";

const skillMarkdown = (body: string) => `---\nname: tritonai-feedback\ndescription: ${body}\n---\n`;

describe("syncTritonAiFeedbackSkill", () => {
  it.effect("installs the skill, then refreshes it only when the source changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skillsDirectory = yield* fs.makeTempDirectoryScoped();
        const source = new Map([
          ["SKILL.md", skillMarkdown("First version.")],
          ["LICENSE", "MIT"],
        ]);
        const fetchFile = (url: string) => {
          const content = source.get(url.split("/").at(-1)!);
          return content === undefined
            ? Effect.fail(new TritonAiFeedbackSkillSyncError({ message: "missing" }))
            : Effect.succeed(content);
        };
        const installedSkill = path.join(skillsDirectory, "tritonai-feedback", "SKILL.md");

        expect(yield* syncTritonAiFeedbackSkill({ skillsDirectory, fetchFile })).toBe("installed");
        expect(yield* fs.readFileString(installedSkill)).toBe(skillMarkdown("First version."));
        expect(yield* syncTritonAiFeedbackSkill({ skillsDirectory, fetchFile })).toBe("current");

        source.set("SKILL.md", skillMarkdown("Second version."));
        expect(yield* syncTritonAiFeedbackSkill({ skillsDirectory, fetchFile })).toBe("installed");
        expect(yield* fs.readFileString(installedSkill)).toBe(skillMarkdown("Second version."));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the installed copy when the source cannot be reached", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skillsDirectory = yield* fs.makeTempDirectoryScoped();
        const skillDirectory = path.join(skillsDirectory, "tritonai-feedback");
        yield* fs.makeDirectory(skillDirectory, { recursive: true });
        yield* fs.writeFileString(path.join(skillDirectory, "SKILL.md"), skillMarkdown("Kept."));

        const error = yield* syncTritonAiFeedbackSkill({
          skillsDirectory,
          fetchFile: () => Effect.fail(new TritonAiFeedbackSkillSyncError({ message: "offline" })),
        }).pipe(Effect.flip);

        expect(error._tag).toBe("TritonAiFeedbackSkillSyncError");
        expect(yield* fs.readFileString(path.join(skillDirectory, "SKILL.md"))).toBe(
          skillMarkdown("Kept."),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a source whose skill name changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const skillsDirectory = yield* fs.makeTempDirectoryScoped();
        const renamed = "---\nname: renamed-feedback\ndescription: Moved.\n---\n";

        const error = yield* syncTritonAiFeedbackSkill({
          skillsDirectory,
          fetchFile: (url) => Effect.succeed(url.endsWith("SKILL.md") ? renamed : "MIT"),
        }).pipe(Effect.flip);

        expect(error._tag).toBe("TritonAiFeedbackSkillSyncError");
        expect(yield* fs.readDirectory(skillsDirectory)).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("runTritonAiFeedbackSkillSync", () => {
  it.effect("syncs at startup and again only when the Codex home moves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* Queue.unbounded<string>();
        const synced = yield* Queue.unbounded<string>();

        yield* runTritonAiFeedbackSkillSync({
          currentSkillsDirectory: Effect.succeed("/home-a/skills"),
          skillsDirectoryChanges: Stream.fromQueue(changes),
          sync: (skillsDirectory) => Queue.offer(synced, skillsDirectory),
          refreshInterval: "1 hour",
        });
        expect(yield* Queue.take(synced)).toBe("/home-a/skills");

        // An unrelated settings change resolves to the same home and is skipped.
        yield* Queue.offer(changes, "/home-a/skills");
        yield* Queue.offer(changes, "/home-b/skills");
        expect(yield* Queue.take(synced)).toBe("/home-b/skills");
        expect(yield* Queue.size(synced)).toBe(0);
      }),
    ),
  );
});
