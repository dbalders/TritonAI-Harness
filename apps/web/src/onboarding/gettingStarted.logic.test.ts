import { describe, expect, it } from "vite-plus/test";

import {
  GETTING_STARTED_CHAPTERS,
  GETTING_STARTED_STEPS,
  isGettingStartedStepOptional,
  mergeGettingStartedProgress,
  resolveGettingStartedState,
  resolveGettingStartedThreadNudge,
  resolveStepsCompletedBySend,
  type GettingStartedSendEvent,
} from "./gettingStarted.logic";

const MORNING = new Date(2026, 8, 30, 9, 0);
const EVENING = new Date(2026, 8, 30, 21, 0);
const NEXT_MORNING = new Date(2026, 9, 1, 8, 0);
const DESKTOP = { desktop: true };
const WEB = { desktop: false };

const SEND: GettingStartedSendEvent = {
  isFollowUp: false,
  attachmentCount: 0,
  text: "hello",
  questStepId: null,
};

const MAIN_STEP_IDS = GETTING_STARTED_STEPS.filter(
  (step) => !isGettingStartedStepOptional(step),
).map((step) => step.id);

function doneAt(ids: ReadonlyArray<string>, date = MORNING): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, date.toISOString()]));
}

function viewOf(progress: Record<string, string>, id: string, now = MORNING) {
  return resolveGettingStartedState(progress, now, DESKTOP).steps.find(
    (view) => view.step.id === id,
  );
}

describe("getting started steps", () => {
  it("have unique ids, known chapters, and earlier prerequisites", () => {
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
  it("starts with the first step and counts only the main quest", () => {
    const state = resolveGettingStartedState({}, MORNING, DESKTOP);
    expect(state.completedCount).toBe(0);
    expect(state.total).toBe(MAIN_STEP_IDS.length);
    expect(state.sideQuestsTotal).toBe(GETTING_STARTED_STEPS.length - MAIN_STEP_IDS.length);
    expect(state.nextStep?.step.id).toBe("say-hello");
    expect(state.isComplete).toBe(false);
  });

  it("offers computer use only in the desktop app", () => {
    const ids = (desktop: boolean) =>
      resolveGettingStartedState({}, MORNING, { desktop }).steps.map((view) => view.step.id);
    expect(ids(true)).toContain("computer-use");
    expect(ids(false)).not.toContain("computer-use");
    expect(resolveGettingStartedState({}, MORNING, WEB).total).toBe(MAIN_STEP_IDS.length);
  });

  it("locks the connected-tool steps until a tool is connected", () => {
    expect(viewOf({}, "morning-brief")?.status).toBe("locked");
    expect(viewOf({}, "brief-to-inbox")?.lockedReason).toContain("Connect your email and calendar");
    const connected = doneAt(["connect-tools"]);
    expect(viewOf(connected, "morning-brief")?.status).toBe("available");
    expect(viewOf(connected, "brief-to-inbox")?.status).toBe("available");
    expect(viewOf(connected, "daily-brief")?.status).toBe("locked");
  });

  it("unlocks picking up where you left off on the next calendar day", () => {
    const progress = doneAt(["say-hello"]);
    expect(viewOf({}, "pick-up")?.status).toBe("locked");
    expect(viewOf(progress, "pick-up", EVENING)?.status).toBe("locked");
    expect(viewOf(progress, "pick-up", NEXT_MORNING)?.status).toBe("available");
  });

  it("is complete when the main quest is done, even with side quests left", () => {
    const state = resolveGettingStartedState(doneAt(MAIN_STEP_IDS), NEXT_MORNING, DESKTOP);
    expect(state.isComplete).toBe(true);
    expect(state.nextStep).toBeNull();
    expect(state.sideQuestsCompleted).toBe(0);
  });

  it("has no next step while only a locked main step remains", () => {
    const state = resolveGettingStartedState(
      doneAt(MAIN_STEP_IDS.filter((id) => id !== "pick-up")),
      EVENING,
      DESKTOP,
    );
    expect(state.nextStep).toBeNull();
    expect(state.isComplete).toBe(false);
  });

  it("ignores progress for steps it does not know", () => {
    const state = resolveGettingStartedState(
      doneAt([...MAIN_STEP_IDS, "retired-step"]),
      NEXT_MORNING,
      DESKTOP,
    );
    expect(state.completedCount).toBe(MAIN_STEP_IDS.length);
  });
});

describe("resolveStepsCompletedBySend", () => {
  it("finishes saying hello on any message", () => {
    expect(
      resolveStepsCompletedBySend(resolveGettingStartedState({}, MORNING, DESKTOP), SEND),
    ).toEqual(["say-hello"]);
  });

  it("finishes steps from what the message holds", () => {
    const state = resolveGettingStartedState(doneAt(["say-hello"]), MORNING, DESKTOP);
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
    expect(
      resolveStepsCompletedBySend(state, {
        ...SEND,
        text: "Use computer use to open Notes and create a note.",
      }),
    ).toEqual(["computer-use"]);
  });

  it("finishes an example step only from the draft it filled", () => {
    const connected = resolveGettingStartedState(
      doneAt(["say-hello", "connect-tools"]),
      MORNING,
      DESKTOP,
    );
    expect(resolveStepsCompletedBySend(connected, SEND)).toEqual([]);
    expect(
      resolveStepsCompletedBySend(connected, { ...SEND, questStepId: "brief-to-inbox" }),
    ).toEqual(["brief-to-inbox"]);
    expect(resolveStepsCompletedBySend(connected, { ...SEND, questStepId: "try-ideas" })).toEqual([
      "try-ideas",
    ]);
  });

  it("does not finish a locked step", () => {
    const state = resolveGettingStartedState(doneAt(["say-hello"]), MORNING, DESKTOP);
    expect(resolveStepsCompletedBySend(state, { ...SEND, questStepId: "morning-brief" })).toEqual(
      [],
    );
  });
});

describe("mergeGettingStartedProgress", () => {
  it("keeps the original time of steps already done", () => {
    const progress = doneAt(["say-hello"]);
    expect(mergeGettingStartedProgress(progress, ["say-hello"], EVENING.toISOString())).toBe(
      progress,
    );
    expect(
      mergeGettingStartedProgress(progress, ["say-hello", "follow-up"], EVENING.toISOString()),
    ).toEqual({ "say-hello": MORNING.toISOString(), "follow-up": EVENING.toISOString() });
  });
});

describe("resolveGettingStartedThreadNudge", () => {
  it("celebrates right after a message finished a step, then shrinks to next up", () => {
    const state = resolveGettingStartedState(doneAt(["say-hello"]), MORNING, DESKTOP);
    expect(resolveGettingStartedThreadNudge(state, ["say-hello"])).toBe("celebrate");
    expect(resolveGettingStartedThreadNudge(state, [])).toBe("next-up");
  });

  it("stays quiet once nothing is left to do today", () => {
    const allButTomorrow = MAIN_STEP_IDS.filter((id) => id !== "pick-up");
    expect(
      resolveGettingStartedThreadNudge(
        resolveGettingStartedState(doneAt(allButTomorrow), EVENING, DESKTOP),
        [],
      ),
    ).toBe("none");
    expect(
      resolveGettingStartedThreadNudge(
        resolveGettingStartedState(doneAt(MAIN_STEP_IDS), NEXT_MORNING, DESKTOP),
        ["pick-up"],
      ),
    ).toBe("celebrate");
  });
});
