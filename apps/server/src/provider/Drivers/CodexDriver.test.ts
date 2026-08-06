import { assert, describe, it } from "@effect/vitest";

import { mergeCodexProviderEnvironment } from "./CodexDriver.ts";

describe("mergeCodexProviderEnvironment", () => {
  it("keeps the Usage-managed TritonAI key authoritative", () => {
    const environment = [
      { name: "TRITONAI_API_KEY", value: "stale-provider-key", sensitive: true },
      { name: "UCSD_AI_BASE_URL", value: "https://tritonai.example/v1", sensitive: false },
    ];

    const result = mergeCodexProviderEnvironment(
      environment,
      { TRITONAI_API_KEY: "replacement-key", PATH: "/managed/bin" },
      "darwin",
    );

    assert.equal(result.TRITONAI_API_KEY, "replacement-key");
    assert.equal(result.UCSD_AI_BASE_URL, "https://tritonai.example/v1");
    assert.equal(result.PATH, "/managed/bin");
  });

  it("normalizes inherited Windows key casing when applying the managed key", () => {
    const result = mergeCodexProviderEnvironment(
      [{ name: "tritonai_api_key", value: "stale-provider-key", sensitive: true }],
      { TRITONAI_API_KEY: "replacement-key" },
      "win32",
    );

    assert.equal(result.TRITONAI_API_KEY, "replacement-key");
    assert.notProperty(result, "tritonai_api_key");
  });
});
