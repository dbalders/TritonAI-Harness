import { ServerTritonAiCommonsError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  findTritonAiCommonsFailure,
  GITHUB_COMMONS_SETUP_CONTINUATION,
} from "./tritonAiCommonsSubmission";

describe("TritonAI Commons submission UI", () => {
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
