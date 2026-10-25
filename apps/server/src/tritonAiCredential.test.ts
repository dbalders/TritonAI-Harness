import { assert, describe, it } from "@effect/vitest";

import { resolveTritonAiServiceApiKey } from "./tritonAiCredential.ts";

describe("resolveTritonAiServiceApiKey", () => {
  it("falls back across split credentials without returning an empty value", () => {
    assert.equal(
      resolveTritonAiServiceApiKey({
        TRITONAI_API_KEY: "  ",
        TRITONAI_ONPREM_API_KEY: "on-prem",
        TRITONAI_FRONTIER_API_KEY: "frontier",
      }),
      "on-prem",
    );
    assert.equal(
      resolveTritonAiServiceApiKey({ TRITONAI_FRONTIER_API_KEY: "frontier" }),
      "frontier",
    );
  });
});
