import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveNewThreadModelSelectionOverride } from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const LAST_SELECTED_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "flash",
};

describe("chatThreadActions", () => {
  // regression: #246 fix(models): remember explicit model choices for new tasks
  it("uses provider defaults only before any manual choice or project override", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        lastSelectedModel: null,
      }),
    ).toBeNull();
  });

  // regression: #246 fix(models): remember explicit model choices for new tasks
  it("uses the last explicit model selection for unpinned projects", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        lastSelectedModel: LAST_SELECTED_MODEL,
      }),
    ).toEqual(LAST_SELECTED_MODEL);
  });

  // regression: #246 fix(models): remember explicit model choices for new tasks
  it("keeps an intentional project override above the last manual choice", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        lastSelectedModel: LAST_SELECTED_MODEL,
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});
