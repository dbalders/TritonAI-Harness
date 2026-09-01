import { assert, describe, it } from "@effect/vitest";

import { mergeCodexProviderEnvironment } from "./CodexDriver.ts";

describe("mergeCodexProviderEnvironment", () => {
  it("keeps the Usage-managed TritonAI key authoritative", () => {
    const environment = [
      { name: "TRITONAI_API_KEY", value: "stale-provider-key", sensitive: true },
      {
        name: "TRITONAI_API_KEY_SOURCE",
        value: "TRITONAI_ONPREM_API_KEY",
        sensitive: false,
      },
      { name: "UCSD_AI_BASE_URL", value: "https://tritonai.example/v1", sensitive: false },
    ];

    const result = mergeCodexProviderEnvironment(
      environment,
      { TRITONAI_API_KEY: "replacement-key", PATH: "/managed/bin" },
      "darwin",
      "codex",
    );

    assert.equal(result.TRITONAI_API_KEY, "replacement-key");
    assert.equal(result.UCSD_AI_BASE_URL, "https://tritonai.example/v1");
    assert.equal(result.PATH, "/managed/bin");
  });

  it("preserves a user-configured key on a non-managed Codex instance", () => {
    const result = mergeCodexProviderEnvironment(
      [
        { name: "TRITONAI_API_KEY", value: "personal-key", sensitive: true },
        { name: "TRITONAI_ONPREM_API_KEY", value: "personal-route-key", sensitive: true },
      ],
      { PATH: "/managed/bin" },
      "darwin",
      "codex_personal",
    );

    assert.equal(result.TRITONAI_API_KEY, "personal-key");
    assert.equal(result.TRITONAI_ONPREM_API_KEY, "personal-route-key");
  });

  it("does not leak inherited route credentials into a non-managed Codex instance", () => {
    const result = mergeCodexProviderEnvironment(
      undefined,
      {
        TRITONAI_ONPREM_API_KEY: "managed-on-prem-key",
        TRITONAI_FRONTIER_API_KEY: "managed-frontier-key",
        PATH: "/managed/bin",
      },
      "darwin",
      "codex_personal",
    );

    assert.notProperty(result, "TRITONAI_ONPREM_API_KEY");
    assert.notProperty(result, "TRITONAI_FRONTIER_API_KEY");
    assert.equal(result.PATH, "/managed/bin");
  });

  it("normalizes inherited Windows key casing when applying the managed key", () => {
    const result = mergeCodexProviderEnvironment(
      [
        { name: "tritonai_api_key", value: "stale-provider-key", sensitive: true },
        {
          name: "tritonai_api_key_source",
          value: "TRITONAI_ONPREM_API_KEY",
          sensitive: false,
        },
      ],
      { TRITONAI_API_KEY: "replacement-key" },
      "win32",
      "codex",
    );

    assert.equal(result.TRITONAI_API_KEY, "replacement-key");
    assert.notProperty(result, "tritonai_api_key");
  });

  it("selects the on-prem credential without exposing the frontier credential", () => {
    const result = mergeCodexProviderEnvironment(
      [
        {
          name: "TRITONAI_API_KEY_SOURCE",
          value: "TRITONAI_ONPREM_API_KEY",
          sensitive: false,
        },
      ],
      {
        TRITONAI_ONPREM_API_KEY: "on-prem-key",
        TRITONAI_FRONTIER_API_KEY: "frontier-key",
      },
      "darwin",
      "codex",
    );

    assert.equal(result.TRITONAI_API_KEY, "on-prem-key");
    assert.notProperty(result, "TRITONAI_ONPREM_API_KEY");
    assert.notProperty(result, "TRITONAI_FRONTIER_API_KEY");
    assert.notProperty(result, "TRITONAI_API_KEY_SOURCE");
  });

  it("selects the frontier credential and lets a shared key override both routes", () => {
    const routeEnvironment = [
      {
        name: "TRITONAI_API_KEY_SOURCE",
        value: "TRITONAI_FRONTIER_API_KEY",
        sensitive: false,
      },
    ];
    const routed = mergeCodexProviderEnvironment(
      routeEnvironment,
      {
        TRITONAI_ONPREM_API_KEY: "on-prem-key",
        TRITONAI_FRONTIER_API_KEY: "frontier-key",
      },
      "darwin",
      "codex_frontier",
    );
    const shared = mergeCodexProviderEnvironment(
      routeEnvironment,
      {
        TRITONAI_API_KEY: "shared-key",
        TRITONAI_FRONTIER_API_KEY: "frontier-key",
      },
      "darwin",
      "codex_frontier",
    );

    assert.equal(routed.TRITONAI_API_KEY, "frontier-key");
    assert.equal(shared.TRITONAI_API_KEY, "shared-key");
  });

  it("ignores unrecognized credential selectors", () => {
    const result = mergeCodexProviderEnvironment(
      [
        {
          name: "TRITONAI_API_KEY_SOURCE",
          value: "UNRELATED_SECRET",
          sensitive: false,
        },
      ],
      { UNRELATED_SECRET: "must-not-be-forwarded" },
      "darwin",
      "codex_personal",
    );

    assert.notProperty(result, "TRITONAI_API_KEY");
    assert.equal(result.UNRELATED_SECRET, "must-not-be-forwarded");
  });

  it("does not let a personal instance select a managed route credential", () => {
    const result = mergeCodexProviderEnvironment(
      [
        {
          name: "TRITONAI_API_KEY_SOURCE",
          value: "TRITONAI_FRONTIER_API_KEY",
          sensitive: false,
        },
      ],
      {
        TRITONAI_API_KEY: "managed-shared-key",
        TRITONAI_FRONTIER_API_KEY: "managed-frontier-key",
      },
      "darwin",
      "codex_personal",
    );

    assert.notProperty(result, "TRITONAI_API_KEY");
    assert.notProperty(result, "TRITONAI_FRONTIER_API_KEY");
    assert.notProperty(result, "TRITONAI_API_KEY_SOURCE");
  });
});
