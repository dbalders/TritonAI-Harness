import { describe, expect, it } from "vite-plus/test";
import { computerUsePrompt, isComputerUseRequest } from "./computerUse";
import { computerUseActivity } from "./components/chat/computerUseActivity";

describe("computer use requests", () => {
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
