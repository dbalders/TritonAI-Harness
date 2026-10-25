import { describe, expect, it } from "vite-plus/test";
import { computerUseActivity } from "./components/chat/computerUseActivity";

describe("computer-use stale observations", () => {
  const stale = "element_token is stale; call get_window_state again to refresh";
  const activity = (data: Record<string, unknown>) =>
    computerUseActivity({
      itemType: "dynamic_tool",
      toolData: { server: "cua-driver", tool: "click", status: "failed", error: null, ...data },
    });

  // regression: #256 fix(web): treat stale computer-use references as normal steps
  it.each([stale, [{ type: "text", text: stale }]])(
    "recognizes the driver's stale reference response: %j",
    (content) => {
      expect(activity({ result: { content } })?.refreshNeeded).toBe(true);
    },
  );
});
