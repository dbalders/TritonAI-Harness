import type { DesktopPetThreadSummary } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

const WORKING_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const PET_THREAD_LIMIT = 12;

export function petThreadStatus(thread: EnvironmentThreadShell): DesktopPetThreadSummary["status"] {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "review";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "review";
  if (thread.hasActionableProposedPlan) return "review";
  if (thread.runtime && WORKING_STATUSES.has(thread.runtime.status)) return "working";
  if (thread.pendingBackgroundTasks.length > 0) return "working";
  if (thread.runtime?.status === "failed") return "failed";
  return "idle";
}

export function petThreadStatusLabel(thread: EnvironmentThreadShell): string {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") return "Approval";
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") return "Input";
  if (thread.hasActionableProposedPlan) return "Plan";
  const status = thread.runtime?.status;
  if (status === "preparing" || status === "queued" || status === "starting") return "Starting";
  if (status === "running") return "Running";
  if (status === "waiting") return "Monitoring";
  if (thread.pendingBackgroundTasks.length > 0) return "Background";
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  return "Idle";
}

export function isPetThreadActive(thread: EnvironmentThreadShell): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
  if (thread.pendingSubagentRequest !== null && thread.pendingSubagentRequest !== undefined)
    return true;
  if (thread.hasActionableProposedPlan) return true;
  if (thread.runtime && WORKING_STATUSES.has(thread.runtime.status)) return true;
  return thread.pendingBackgroundTasks.length > 0;
}

function compareThreadUpdate(left: EnvironmentThreadShell, right: EnvironmentThreadShell) {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function toPetThreadSummary(thread: EnvironmentThreadShell): DesktopPetThreadSummary {
  return {
    environmentId: thread.environmentId,
    threadId: thread.id,
    title: thread.title.length > 0 ? thread.title : "Untitled thread",
    status: petThreadStatus(thread),
    statusLabel: petThreadStatusLabel(thread),
  };
}

const threadKey = (thread: EnvironmentThreadShell) =>
  JSON.stringify([thread.environmentId, thread.id]);

export function computePetSummaries(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  seen: Set<string> = new Set(),
) {
  for (const thread of threads) {
    if (isPetThreadActive(thread)) seen.add(threadKey(thread));
  }
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null && thread.deletedAt === null && seen.has(threadKey(thread)),
    )
    .slice()
    .sort(
      (left, right) =>
        Number(isPetThreadActive(right)) - Number(isPetThreadActive(left)) ||
        compareThreadUpdate(left, right),
    )
    .slice(0, PET_THREAD_LIMIT)
    .map(toPetThreadSummary);
}
