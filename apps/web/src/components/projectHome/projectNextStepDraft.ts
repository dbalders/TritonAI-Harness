import type { ProjectNextStep, ProjectOverview } from "@t3tools/contracts";

/** Freeze the evidence behind a suggestion into its draft; never imply it is current acceptance. */
export function projectNextStepDraft(overview: ProjectOverview, step: ProjectNextStep): string {
  const sources = overview.sources.filter((source) => step.sources.includes(source.ref));
  return [
    step.prompt,
    "Project context carried from the project overview:",
    overview.description,
    `Suggested from saved context on ${overview.generatedAt}. Check the current project before acting; an agent's report is not owner acceptance or proof of merge, deployment, or release.`,
    ...sources.map((source) => `Source: ${source.title} (${source.ref})\n${source.text}`),
  ].join("\n\n");
}
