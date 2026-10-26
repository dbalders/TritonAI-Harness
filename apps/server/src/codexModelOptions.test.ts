import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";

import { createModelSelection } from "@t3tools/shared/model";

import { getCodexServiceTierOptionValue } from "./codexModelOptions.ts";

it("sends an explicit default tier so a previous priority selection is cleared", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "default" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "default");
});

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});
