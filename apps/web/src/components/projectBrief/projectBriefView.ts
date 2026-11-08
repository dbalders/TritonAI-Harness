import type { ProjectBriefExecution, ProjectBriefState } from "@t3tools/contracts";

export function projectBriefSourcesChanged(state: ProjectBriefState): boolean {
  return (
    state.sources.some((source) => source.status !== "available") ||
    (state.brief !== null && state.brief.sourceDigest !== state.sourceDigest)
  );
}

export function projectBriefCanArchive(state: ProjectBriefState): boolean {
  return (
    (!state.synthesis ||
      !["dispatch-pending", "running", "uncertain"].includes(state.synthesis.status)) &&
    !state.executions.some((execution) =>
      ["dispatch-pending", "queued", "running", "uncertain"].includes(execution.status),
    )
  );
}

export function projectBriefExecutionLabel(status: ProjectBriefExecution["status"]): string {
  switch (status) {
    case "dispatch-pending":
      return "Starting thread";
    case "queued":
      return "Queued";
    case "running":
      return "Working";
    case "needs-review":
      return "Ready for your review";
    case "result-missing":
      return "Result missing";
    case "completed":
      return "Reviewed complete";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "uncertain":
      return "Status needs checking";
    case "cancelled":
      return "Cancelled";
    case "withdrawn":
      return "Tracking withdrawn";
  }
}

export function projectBriefSafeSourceUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
