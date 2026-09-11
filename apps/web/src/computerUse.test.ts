import { describe, expect, it, vi } from "vite-plus/test";
import {
  computerUsePrompt,
  isComputerUseRequest,
  isBareComputerUseRequest,
  readComputerUseStateWithTimeout,
} from "./computerUse";
import { computerUseActivity } from "./components/chat/computerUseActivity";

describe("computer use requests", () => {
  it("recognizes bare commands consistently", () => {
    expect(isBareComputerUseRequest(" /COMPUTER-USE ")).toBe(true);
    expect(isBareComputerUseRequest("/computer-use open Notes")).toBe(false);
    expect(isBareComputerUseRequest("/computer-useful")).toBe(false);
  });
  it("recognizes deliberate commands without blocking discussion of the feature", () => {
    expect(isComputerUseRequest("/computer-use open Notes")).toBe(true);
    expect(isComputerUseRequest("Please use computer use to open Notes")).toBe(true);
    expect(isComputerUseRequest("can you use computer use to open Notes")).toBe(true);
    expect(isComputerUseRequest("/computer-useful")).toBe(false);
    expect(isComputerUseRequest("Fix the computer use setting")).toBe(false);
    expect(computerUsePrompt("/computer-use open Notes")).toBe("Use computer use to open Notes");
  });
  it("highlights actual driver calls, not text that merely mentions computer use", () => {
    expect(
      computerUseActivity({
        itemType: "command_execution",
        toolData: { server: "cua-driver", tool: "click" },
      }),
    ).toBeNull();
    expect(
      computerUseActivity({
        itemType: "mcp_tool_call",
        toolData: { server: "other", tool: "click" },
      }),
    ).toBeNull();
    expect(
      computerUseActivity({
        itemType: "mcp_tool_call",
        toolData: {
          server: "cua-driver",
          tool: "capture_window",
          arguments: { session_name: "Notes" },
        },
      }),
    ).toEqual({ action: "Capture screen", session: "Notes" });
  });
});

describe("computer-use readiness deadline", () => {
  it("releases a stalled check and permits a subsequent successful check", async () => {
    vi.useFakeTimers();
    try {
      const stalled = readComputerUseStateWithTimeout(() => new Promise<never>(() => {}));
      const rejected = expect(stalled).rejects.toThrow("status check timed out");
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      await expect(readComputerUseStateWithTimeout(() => Promise.resolve("ready"))).resolves.toBe(
        "ready",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves IPC errors and removes the deadline", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        readComputerUseStateWithTimeout(() => Promise.reject(new Error("disconnected"))),
      ).rejects.toThrow("disconnected");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
