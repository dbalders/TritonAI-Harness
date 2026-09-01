import { ServerTritonAiCommonsError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  findTritonAiCommonsFailure,
  GITHUB_COMMONS_SETUP_CONTINUATION,
  tritonAiCommonsPublicShareConfirmation,
} from "./tritonAiCommonsSubmission";

describe("TritonAI Commons submission UI", () => {
  it("states the complete public boundary before consent", () => {
    const message = tritonAiCommonsPublicShareConfirmation({
      displayName: "Accessibility Review",
      skillPath: "/Users/example/.codex/skills/accessibility-review/SKILL.md",
    });

    expect(message).toContain("publicly with UCSD");
    expect(message).toContain("Every supported, non-hidden text file");
    expect(message).toContain("connected GitHub identity");
    expect(message).toContain("ready-for-review pull request");
    expect(message).toContain("never merge");
    expect(message).not.toContain("approved by UCSD");
  });

  it("recognizes only the structured GitHub setup interruption", () => {
    const error = new ServerTritonAiCommonsError({
      code: "github_setup_required",
      message: "Connect GitHub.",
    });
    const result = AsyncResult.failure(Cause.fail(error));

    expect(findTritonAiCommonsFailure(result)).toBe(error);
    expect(findTritonAiCommonsFailure(AsyncResult.success({}))).toBeNull();
    expect(GITHUB_COMMONS_SETUP_CONTINUATION).toContain("Settings > Plugins > GitHub");
    expect(GITHUB_COMMONS_SETUP_CONTINUATION).toContain("press Share with UCSD again");
  });
});
