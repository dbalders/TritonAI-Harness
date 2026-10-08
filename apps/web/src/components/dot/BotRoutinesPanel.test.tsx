// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BotRoutinesPanel, type BotRoutinesPanelProps } from "./BotRoutinesPanel";
import type { DotScheduledPrompt, DotWatch } from "./dotRoutines";

const at = "2026-10-08T12:00:00.000Z";
const prompt: DotScheduledPrompt = {
  promptId: "sp_0123456789ab",
  name: "Inbox check",
  prompt: "Check my inbox for budget approvals.",
  schedule: { kind: "weekdays", time: "08:00" },
  scheduleText: "Every weekday at 08:00",
  timezone: "America/Los_Angeles",
  threadId: "routine-thread",
  notify: "if-notable",
  enabled: true,
  nextRunAt: "2026-10-08T15:00:00.000Z",
  consecutiveUnread: 0,
  spendGuard: true,
  createdAt: at,
  updatedAt: at,
};
const watch: DotWatch = {
  watchId: "watch-1",
  source: "github",
  target: "example/project",
  spec: { repo: "example/project", events: ["release"] },
  watching: "New releases",
  status: "active",
  delivery: "immediate",
  cadence: "about every 5 minutes",
  createdAt: at,
};

describe("BotRoutinesPanel", () => {
  let root: Root;
  let container: HTMLDivElement;
  const action = vi.fn<BotRoutinesPanelProps["onPromptAction"]>();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
    action.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(overrides: Partial<BotRoutinesPanelProps> = {}) {
    await act(async () =>
      root.render(
        <BotRoutinesPanel
          watches={undefined}
          scheduledPrompts={[prompt]}
          onPromptAction={action}
          {...overrides}
        />,
      ),
    );
    const details = container.querySelector("details");
    if (details && !details.open)
      await act(async () => container.querySelector("summary")!.click());
  }
  function button(label: string, scope: ParentNode = container): HTMLButtonElement {
    const found = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(found, `Button ${label}`).toBeDefined();
    return found!;
  }
  async function click(label: string, scope: ParentNode = container) {
    await act(async () => button(label, scope).click());
  }

  it("hides unsupported features, then makes supported empty states reachable through the disclosure", async () => {
    await render({ scheduledPrompts: undefined });
    expect(container.textContent).toBe("");
    await render({ watches: [], scheduledPrompts: [] });
    expect(container.querySelector("details")!.open).toBe(true);
    expect(container.textContent).toContain("No watches yet");
    expect(container.textContent).toContain("No routines yet");
    await act(async () => container.querySelector("summary")!.click());
    expect(container.querySelector("details")!.open).toBe(false);
  });

  it("exposes watch status and real Teams instructions without inventing mutation buttons", async () => {
    await render({ watches: [watch], scheduledPrompts: undefined });
    expect(container.textContent).toContain("Never checked");
    expect(container.textContent).toContain("No successful check yet");
    expect(container.textContent).toContain("Next check: Not available");
    expect(container.textContent).toContain("/watches pause watch-1");
    expect(container.textContent).toContain("/watches stop watch-1");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelector('[aria-label="Scheduled prompts"]')).toBeNull();
    await render({
      watches: [{ ...watch, status: "paused", nextCheckAt: at }],
      scheduledPrompts: undefined,
    });
    expect(container.textContent).toContain("Next check: Not scheduled");
    expect(container.textContent).toContain("/watches resume watch-1");
    expect(container.textContent).toContain("changes while paused are not replayed");
    expect(action).not.toHaveBeenCalled();
  });

  it("keeps a failed check distinct from a successful check and explains overdue freshness", async () => {
    await render({
      watches: [
        {
          ...watch,
          lastCheckedAt: at,
          lastSuccessAt: "2026-10-07T12:00:00Z",
          nextCheckAt: at,
          lastError: "Source unavailable",
        },
      ],
      scheduledPrompts: undefined,
    });
    expect(container.textContent).toContain("Source unavailable");
    expect(container.textContent).toContain(
      "Changes since the last successful check may be missing",
    );
    expect(container.textContent).toContain("Check due; no newer check is confirmed");
    await render({ watches: [{ ...watch, status: "expired" }], scheduledPrompts: undefined });
    expect(container.textContent).toContain("Expired");
    expect(container.textContent).toContain("Next check: Not scheduled");
    expect(container.textContent).not.toContain("/watches resume");
  });

  it("marks a check due even without new props, then removes its timer when paused", async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    const nextCheckAt = new Date(Date.parse(at) + 1000).toISOString();
    await render({ watches: [{ ...watch, nextCheckAt }], scheduledPrompts: undefined });
    // jsdom dispatches the native disclosure's toggle event on its own zero-delay timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.textContent).not.toContain("Check due");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(container.textContent).toContain("Check due; no newer check is confirmed");
    expect(vi.getTimerCount()).toBe(0);
    await render({
      watches: [{ ...watch, status: "paused", nextCheckAt }],
      scheduledPrompts: undefined,
    });
    expect(container.textContent).not.toContain("Check due");
    expect(container.textContent).toContain("Next check: Not scheduled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the Stop dialog with Escape and restores keyboard focus without deleting", async () => {
    await render();
    button("Stop").focus();
    await click("Stop");
    const dialog = document.querySelector('[role="alertdialog"]')!;
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Stop"));
    expect(action).not.toHaveBeenCalled();
  });

  it("shows a guarded pause and failed prior run without inventing error details", async () => {
    await render({
      scheduledPrompts: [
        {
          ...prompt,
          enabled: false,
          pausedReason: "unread",
          lastRun: { at, outcome: "failed", runId: "previous" },
        },
      ],
    });
    expect(container.textContent).toContain("Paused after unread results to limit spending");
    expect(container.textContent).toContain("Failed; error details are not provided here");
    expect(container.textContent).toContain("Next run: Not scheduled");
    expect(button("Resume").disabled).toBe(false);
  });

  it("locks actions while pending and follows refreshed pause/resume state", async () => {
    let resolve: (response: unknown) => void = () => {};
    action.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await click("Pause");
    expect(button("Run now").disabled).toBe(true);
    expect(button("Stop").disabled).toBe(true);
    await click("Run now");
    expect(action).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Active");
    await act(async () => resolve({ ok: true }));
    const paused = { ...prompt, enabled: false, pausedReason: "owner" as const };
    await render({ scheduledPrompts: [paused] });
    expect(container.textContent).toContain("Paused by you");
    action.mockResolvedValueOnce({ ok: true, prompt });
    await click("Resume");
    expect(action).toHaveBeenLastCalledWith(paused, "resume");
    expect(container.querySelector('[role="status"]')!.textContent).toContain(
      "Resume request accepted",
    );
    await render();
    expect(button("Pause").disabled).toBe(false);
  });

  it("announces rejected actions, preserves current state, and permits a retry", async () => {
    action.mockRejectedValueOnce(new Error("Bot is paused"));
    await render();
    await click("Pause");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Bot is paused");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(button("Pause").disabled).toBe(false);
    action.mockResolvedValueOnce({ ok: true });
    await click("Pause");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Pause request accepted.");
  });

  it.each([
    ["queued", false, "Run queued; it has not finished."],
    ["running", false, "Run started; it has not finished."],
    ["waiting-approval", false, "Run needs your approval."],
    ["completed", true, "This request was already received. Run completed."],
  ])("uses the actual %s Run now acknowledgment", async (status, duplicate, expected) => {
    action.mockResolvedValueOnce({
      ok: true,
      runId: "new-run",
      threadId: "routine-thread",
      status,
      duplicate,
    });
    await render();
    await click("Run now");
    expect(container.querySelector('[role="status"]')!.textContent).toContain(expected);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    [{ ok: true, runId: "run", status: "failed" }, "Run failed"],
    [{ ok: true, runId: "run", status: "uncertain" }, "Run outcome is uncertain"],
    [{ ok: true, runId: "run", status: "cancelled" }, "Run was cancelled"],
    [{ ok: true }, "Run now status is unavailable"],
    [{ ok: false, error: "Wait ten minutes" }, "Wait ten minutes"],
  ])("never reports a failed or unknown run as successful (%j)", async (response, expected) => {
    action.mockResolvedValueOnce(response);
    await render();
    await click("Run now");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(expected);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(button("Run now").disabled).toBe(false);
  });

  it("requires Stop confirmation, supports cancel, and retains the confirmation on failure", async () => {
    await render();
    button("Stop").focus();
    await click("Stop");
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
      "Past results remain in history",
    );
    expect(action).not.toHaveBeenCalled();
    await click("Cancel", document);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Stop"));
    await click("Stop");
    action.mockRejectedValueOnce(new Error("Could not stop routine"));
    await click("Stop routine", document);
    expect(action).toHaveBeenLastCalledWith(prompt, "delete");
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe("Could not stop routine");
    expect(button("Stop routine", dialog).disabled).toBe(false);
    action.mockResolvedValueOnce({ ok: true });
    await click("Stop routine", document);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[role="status"]')!.textContent).toContain("Routine stopped");
    await render({ scheduledPrompts: [] });
    expect(container.textContent).toContain("No routines yet");
    expect(container.textContent).not.toContain("Inbox check");
  });
});
