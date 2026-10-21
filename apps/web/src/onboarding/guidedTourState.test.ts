import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readGuidedTourState, restartGuidedTour, updateGuidedTourState } from "./guidedTourState";

describe("guided tour state", () => {
  it("keeps the step and the chat it handed off to, and forgets both on restart", () => {
    updateGuidedTourState({
      step: "file",
      roleId: "finance",
      taskId: "finance-budget",
      taskEnvironmentId: EnvironmentId.make("local"),
      taskThreadId: ThreadId.make("thread-1"),
      usedFollowUps: ["Which line has the most left?"],
      chatGuideDismissed: true,
    });
    expect(readGuidedTourState()).toMatchObject({
      step: "file",
      roleId: "finance",
      taskThreadId: "thread-1",
      chatGuideDismissed: true,
    });

    restartGuidedTour();
    expect(readGuidedTourState()).toEqual({
      step: "welcome",
      roleId: null,
      taskId: null,
      provider: null,
      taskEnvironmentId: null,
      taskThreadId: null,
      usedFollowUps: [],
      chatGuideDismissed: false,
    });
  });
});
