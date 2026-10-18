import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectNextStep, ProjectOverview } from "@t3tools/contracts";
import { threadContextRecord } from "../../lib/composerContextRecords";

/** Keep the chosen action in the user's voice; source history travels as thread references. */
export function projectNextStepDraft(
  environmentId: EnvironmentId,
  overview: ProjectOverview,
  step: ProjectNextStep,
) {
  const sources = overview.sources.filter((source) => step.sources.includes(source.ref));
  return {
    prompt: step.title,
    threadContexts: sources.flatMap((source) =>
      source.threadId
        ? [threadContextRecord(scopeThreadRef(environmentId, source.threadId), source.title)]
        : [],
    ),
  };
}
