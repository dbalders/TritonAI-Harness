import { describe, expect, it } from "vite-plus/test";

import {
  GETTING_STARTED_CHAPTERS,
  GETTING_STARTED_STEPS,
  mergeGettingStartedProgress,
  resolveGettingStartedState,
  resolveStepsCompletedBySend,
  type GettingStartedSendEvent,
} from "./gettingStarted.logic";

const MORNING = new Date(2026, 8, 30, 9, 0);
const EVENING = new Date(2026, 8, 30, 21, 0);
const NEXT_MORNING = new Date(2026, 9, 1, 8, 0);

const SEND: GettingStartedSendEvent = {
  isFollowUp: false,
  attachmentCount: 0,
  text: "hello",
  questStepId: null,
};

function statusOf(progress: Record<string, string>, id: string, now = MORNING) {
  return resolveGettingStartedState(progress, now).steps.find((view) => view.step.id === id)
    ?.status;
}

describe("getting started steps", () => {
  it("have unique ids, known chapters, and valid prerequisites", () => {
    const ids = GETTING_STARTED_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    const chapterIds = new Set(GETTING_STARTED_CHAPTERS.map((chapter) => chapter.id));
    for (const step of GETTING_STARTED_STEPS) {
      expect(chapterIds.has(step.chapter)).toBe(true);
      for (const required of step.requires ?? []) {
        expect(ids.indexOf(required)).toBeLessThan(ids.indexOf(step.id));
      }
    }
  });
});

describe("resolveGettingStartedState", () => {
  it("starts with the first step and nothing done", () => {
    const state = resolveGettingStartedState({}, MORNING);
    expect(state.completedCount).toBe(0);
    expect(state.total).toBe(GETTING_STARTED_STEPS.length);
    expect(state.nextStep?.step.id).toBe("say-hello");
    expect(state.isComplete).toBe(false);
  });

  it("locks the morning brief until a tool is connected", () => {
    expect(statusOf({}, "morning-brief")).toBe("locked");
    expect(
      resolveGettingStartedState({}, MORNING).steps.find((view) => view.step.id === "morning-brief")
        ?.lockedReason,
    ).toContain("Connect your email and calendar");
    expect(statusOf({ "connect-tools": MORNING.toISOString() }, "morning-brief")).toBe("available");
  });

  it("unlocks picking up where you left off on the next calendar day", () => {
    const progress = { "say-hello": MORNING.toISOString() };
    expect(statusOf({}, "pick-up")).toBe("locked");
    expect(statusOf(progress, "pick-up", EVENING)).toBe("locked");
    expect(statusOf(progress, "pick-up", NEXT_MORNING)).toBe("available");
  });

  it("skips done and locked steps when choosing the next one", () => {
    const state = resolveGettingStartedState(
      {
        "say-hello": MORNING.toISOString(),
        "follow-up": MORNING.toISOString(),
        "share-file": MORNING.toISOString(),
        "connect-tools": MORNING.toISOString(),
        "morning-brief": MORNING.toISOString(),
        "use-skill": MORNING.toISOString(),
        "stay-in-control": MORNING.toISOString(),
      },
      EVENING,
    );
    expect(state.nextStep).toBeNull();
    expect(state.isComplete).toBe(false);
  });

  it("ignores progress for steps it does not know", () => {
    const progress = Object.fromEntries(
      [...GETTING_STARTED_STEPS.map((step) => step.id), "retired-step"].map((id) => [
        id,
        MORNING.toISOString(),
      ]),
    );
    const state = resolveGettingStartedState(progress, NEXT_MORNING);
    expect(state.completedCount).toBe(GETTING_STARTED_STEPS.length);
    expect(state.isComplete).toBe(true);
  });
});

describe("resolveStepsCompletedBySend", () => {
  it("finishes saying hello on any message", () => {
    expect(resolveStepsCompletedBySend(resolveGettingStartedState({}, MORNING), SEND)).toEqual([
      "say-hello",
    ]);
  });

  it("finishes the follow-up, file, and skill steps from what the message holds", () => {
    const state = resolveGettingStartedState({ "say-hello": MORNING.toISOString() }, MORNING);
    expect(resolveStepsCompletedBySend(state, { ...SEND, isFollowUp: true })).toEqual([
      "follow-up",
    ]);
    expect(resolveStepsCompletedBySend(state, { ...SEND, attachmentCount: 1 })).toEqual([
      "share-file",
    ]);
    expect(
      resolveStepsCompletedBySend(state, { ...SEND, text: "$ucsd-brand-compliance fix this" }),
    ).toEqual(["use-skill"]);
    expect(resolveStepsCompletedBySend(state, { ...SEND, text: "costs $5 total" })).toEqual([]);
  });

  it("finishes an example step only from the draft it filled", () => {
    const connected = resolveGettingStartedState(
      { "say-hello": MORNING.toISOString(), "connect-tools": MORNING.toISOString() },
      MORNING,
    );
    expect(resolveStepsCompletedBySend(connected, SEND)).toEqual([]);
    expect(
      resolveStepsCompletedBySend(connected, { ...SEND, questStepId: "morning-brief" }),
    ).toEqual(["morning-brief"]);
  });

  it("does not finish a locked step", () => {
    const state = resolveGettingStartedState({ "say-hello": MORNING.toISOString() }, MORNING);
    expect(resolveStepsCompletedBySend(state, { ...SEND, questStepId: "morning-brief" })).toEqual(
      [],
    );
  });
});

describe("mergeGettingStartedProgress", () => {
  it("keeps the original time of steps already done", () => {
    const progress = { "say-hello": MORNING.toISOString() };
    expect(mergeGettingStartedProgress(progress, ["say-hello"], EVENING.toISOString())).toBe(
      progress,
    );
    expect(
      mergeGettingStartedProgress(progress, ["say-hello", "follow-up"], EVENING.toISOString()),
    ).toEqual({ "say-hello": MORNING.toISOString(), "follow-up": EVENING.toISOString() });
  });
});
