import type { ServerBotTaskComputerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeTaskComputer, describeThisComputer, isTaskComputer } from "./BotSettings.logic";

const local: ServerBotTaskComputerStatus = {
  state: "idle",
  deviceId: "this-device",
  deviceName: "MacBook",
  apiUrl: "https://bot.example.test",
  userId: "owner",
  projectId: "project-1",
  currentTask: null,
  lastCheckInAt: null,
  message: null,
};
const remote = {
  deviceId: "this-device",
  deviceName: "MacBook",
  pairedAt: "2026-10-08T06:00:00.000Z",
  online: true,
};
const unidentified = {
  deviceName: "Another computer",
  pairedAt: "2026-10-08T06:00:00.000Z",
  online: true,
};

describe("bot settings wording", () => {
  it("treats the bot as the authority on which computer runs tasks", () => {
    expect(isTaskComputer(remote, local)).toBe(true);
    expect(isTaskComputer({ ...remote, deviceId: "other" }, local)).toBe(false);
    expect(isTaskComputer(null, local)).toBe(false);
    expect(isTaskComputer(unidentified, null)).toBe(false);
    expect(isTaskComputer(unidentified, local)).toBe(false);
    expect(isTaskComputer(remote, null)).toBe(false);
    expect(isTaskComputer({ ...remote, deviceId: "" }, { ...local, deviceId: "" })).toBe(false);
    // Before the bot's state loads, fall back to what this computer reports.
    expect(isTaskComputer(undefined, local)).toBe(true);
    expect(isTaskComputer(undefined, { ...local, state: "replaced" })).toBe(false);
  });

  it("describes the task computer from any Harness", () => {
    expect(describeTaskComputer(remote, true)).toBe(
      "MacBook (this computer) is online and runs approved Harness tasks.",
    );
    expect(describeTaskComputer({ ...remote, online: false }, false)).toContain(
      "has not checked in yet",
    );
    expect(describeTaskComputer(null, false)).toContain("They wait until you choose Allow");
  });

  it("describes what this computer is doing", () => {
    expect(describeThisComputer(null)).toBe("Checking this computer…");
    expect(describeThisComputer({ ...local, state: "off" })).toContain("Choose Allow");
    expect(describeThisComputer({ ...local, state: "replaced", message: null })).toContain(
      "Another computer",
    );
    expect(
      describeThisComputer({
        ...local,
        state: "running",
        currentTask: { taskId: "t", title: "Check releases", threadId: null, startedAt: "" },
      }),
    ).toBe("Running “Check releases” in a Harness thread.");
  });
});
