import type { ModelSelection } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  const selectedTier = getModelSelectionStringOptionValue(modelSelection, "serviceTier");
  if (selectedTier && selectedTier !== "default") {
    return selectedTier;
  }
  return getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true
    ? "fast"
    : undefined;
}
