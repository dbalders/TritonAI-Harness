import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  editableProviderEnvironment,
  mergeEditableProviderEnvironment,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("hides managed routing variables while preserving them across unrelated edits", () => {
    const current = [
      { name: "UCSD_AI_BASE_URL", value: "https://example.test/v1", sensitive: false },
      {
        name: "TRITONAI_API_KEY_SOURCE",
        value: "TRITONAI_ONPREM_API_KEY",
        sensitive: false,
      },
      { name: "PERSONAL_LABEL", value: "blue", sensitive: false },
    ];

    expect(editableProviderEnvironment(current, true)).toEqual([
      { name: "PERSONAL_LABEL", value: "blue", sensitive: false },
    ]);
    expect(
      mergeEditableProviderEnvironment(
        current,
        [{ name: "PERSONAL_LABEL", value: "green", sensitive: false }],
        true,
      ),
    ).toEqual([
      { name: "UCSD_AI_BASE_URL", value: "https://example.test/v1", sensitive: false },
      {
        name: "TRITONAI_API_KEY_SOURCE",
        value: "TRITONAI_ONPREM_API_KEY",
        sensitive: false,
      },
      { name: "PERSONAL_LABEL", value: "green", sensitive: false },
    ]);
  });
});
