import {
  isThreadGoalRevisionNewer,
  normalizeThreadGoalRevisionAt,
  ThreadGoal,
  type OrchestrationThreadActivity,
  type ThreadGoal as ThreadGoalValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isThreadGoal = Schema.is(ThreadGoal);

/** Derive the latest provider-confirmed goal from durable thread activities. */
export function deriveThreadGoal(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ThreadGoalValue | null {
  let latest: {
    readonly revisionAt: string;
    readonly ordering: number;
    readonly goal: ThreadGoalValue | null;
  } | null = null;
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    if (!activity) continue;
    let candidate: { readonly revisionAt: string; readonly goal: ThreadGoalValue | null } | null =
      null;
    if (activity.kind === "goal.cleared") {
      candidate = { revisionAt: activity.createdAt, goal: null };
    } else if (activity.kind === "goal.updated") {
      const goal =
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        "goal" in activity.payload
          ? activity.payload.goal
          : undefined;
      if (isThreadGoal(goal)) {
        candidate = { revisionAt: goal.updatedAt, goal };
      }
    }
    if (!candidate) continue;
    const ordering = activity.sequence ?? index;
    if (
      latest === null ||
      isThreadGoalRevisionNewer({
        currentAt: latest.revisionAt,
        currentSequence: latest.ordering,
        candidateAt: candidate.revisionAt,
        candidateSequence: ordering,
      })
    ) {
      latest = {
        revisionAt: normalizeThreadGoalRevisionAt(candidate.revisionAt),
        ordering,
        goal: candidate.goal,
      };
    }
  }
  return latest?.goal ?? null;
}
