import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  listTritonAiCommonsSubmissionReceipts,
  recordTritonAiCommonsSubmissionReceipt,
} from "./tritonAiCommonsReceipts.ts";

it.layer(NodeServices.layer)("TritonAI Commons submission receipts", (it) => {
  it.effect(
    "persists a durable receipt and replaces an older receipt for the same local skill",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "commons-receipts-" });
        const skillPath = "/Users/example/.codex/skills/accessibility-review/SKILL.md";

        expect(yield* listTritonAiCommonsSubmissionReceipts(stateDir)).toEqual([]);

        yield* recordTritonAiCommonsSubmissionReceipt({
          stateDir,
          skillPath,
          submittedAt: "2026-09-01T20:00:00.000Z",
          result: {
            reviewUrl: "https://github.com/dbalders/UCSD-Skills-Library/pull/41",
            branch: "tritonai-commons/accessibility-review-old",
            path: "community/accessibility-review/SKILL.md",
            skillName: "accessibility-review",
          },
        });
        yield* recordTritonAiCommonsSubmissionReceipt({
          stateDir,
          skillPath,
          submittedAt: "2026-09-02T20:00:00.000Z",
          result: {
            reviewUrl: "https://github.com/dbalders/UCSD-Skills-Library/pull/42",
            branch: "tritonai-commons/accessibility-review-new",
            path: "community/accessibility-review/SKILL.md",
            skillName: "accessibility-review",
          },
        });

        expect(yield* listTritonAiCommonsSubmissionReceipts(stateDir)).toEqual([
          {
            reviewUrl: "https://github.com/dbalders/UCSD-Skills-Library/pull/42",
            branch: "tritonai-commons/accessibility-review-new",
            path: "community/accessibility-review/SKILL.md",
            skillName: "accessibility-review",
            skillPath,
            submittedAt: "2026-09-02T20:00:00.000Z",
          },
        ]);
      }),
  );

  it.effect("serializes simultaneous chat and Settings receipts without losing either", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "commons-receipts-race-" });

      yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          recordTritonAiCommonsSubmissionReceipt({
            stateDir,
            skillPath: `/Users/example/.codex/skills/skill-${index}/SKILL.md`,
            submittedAt: `2026-09-02T20:00:${String(index).padStart(2, "0")}.000Z`,
            result: {
              reviewUrl: `https://github.com/dbalders/UCSD-Skills-Library/pull/${index + 1}`,
              branch: `tritonai-commons/skill-${index}`,
              path: `community/skill-${index}/SKILL.md`,
              skillName: `skill-${index}`,
            },
          }),
        { concurrency: "unbounded" },
      );

      const receipts = yield* listTritonAiCommonsSubmissionReceipts(stateDir);
      expect(receipts).toHaveLength(20);
      expect(new Set(receipts.map(({ skillName }) => skillName)).size).toBe(20);
    }),
  );
});
