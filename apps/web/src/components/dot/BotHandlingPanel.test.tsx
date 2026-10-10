// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { BotHandlingPanel } from "./BotHandlingPanel";
import type { DotHandlingItem, DotHandlingStopResult, DotHandlingView } from "./dotHandling";

const item = (patch: Partial<DotHandlingItem> = {}): DotHandlingItem => ({
  kind: "reminder",
  id: "budget",
  title: "Send the budget",
  state: "scheduled",
  version: "opaque:revision/abc",
  controls: ["stop"],
  ...patch,
});

const view = (
  items: readonly DotHandlingItem[],
  patch: Partial<DotHandlingView> = {},
): DotHandlingView => ({
  generatedAt: "2026-10-08T12:00:00.000Z",
  paused: false,
  timezone: "America/Los_Angeles",
  items,
  unavailable: [],
  ...patch,
});

const result = (patch: Partial<DotHandlingStopResult> = {}): DotHandlingStopResult => ({
  ok: true,
  stopped: true,
  outcome: "stopped",
  kind: "reminder",
  id: "budget",
  message: "Stopped the reminder.",
  ...patch,
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  handling: DotHandlingView | undefined,
  onStop = vi.fn(async (_item: DotHandlingItem) => result()),
) {
  await act(async () => root.render(<BotHandlingPanel handling={handling} onStop={onStop} />));
  return onStop;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

function headings() {
  return [...container.querySelectorAll("h3")].map((heading) => heading.textContent);
}

it("hides an absent API and updates groups from server states without inventing optional fields", async () => {
  const onStop = await render(undefined);
  expect(container.textContent).toBe("");
  await render(
    view([
      item({ id: "decision", title: "Owner decision", state: "waiting-for-you" }),
      item({ id: "failed", title: "Failed check", state: "failed" }),
      item({ id: "uncertain", title: "Inspect effects", state: "uncertain" }),
      item({ id: "running", title: "Running check", state: "working" }),
      item({ id: "queued", title: "Queued check", state: "waiting-on-system" }),
      item(),
      item({ id: "finished", title: "Returned result", state: "done-unseen", controls: ["open"] }),
    ]),
    onStop,
  );
  expect(headings()).toEqual(["Needs you", "Working", "Scheduled", "Recently done"]);
  const groups = [...container.querySelectorAll("section section")];
  expect(groups.map((group) => group.querySelectorAll("li").length)).toEqual([3, 2, 1, 1]);
  expect(container.textContent).not.toContain("Up next");
  expect(container.textContent).not.toContain("Source:");
  expect(container.textContent).not.toContain("Last activity:");
  expect(onStop).not.toHaveBeenCalled();
  await render(view([item({ state: "done-unseen", controls: [] })]), onStop);
  expect(headings()).toEqual(["Recently done"]);
});

it("shows Up next, unknown times, paused status and unavailable sources honestly", async () => {
  await render(
    view([item({ upNext: { what: "Wait for the next check" } })], {
      paused: true,
      upNext: { at: "2026-10-08T14:00:00.000Z", title: "Morning check", what: "Check the inbox" },
      unavailable: ["Meeting settings"],
    }),
  );
  expect(headings()).toEqual(["Up next", "Scheduled"]);
  expect(container.textContent).toContain("Morning check: Check the inbox");
  expect(container.textContent).toContain("Paused");
  expect(container.querySelector("time")?.dateTime).toBe("2026-10-08T14:00:00.000Z");
  expect(container.querySelector('[aria-label="Time unknown"]')).not.toBeNull();
  expect(container.textContent).toContain("Meeting settings");
  expect(container.textContent).toContain("Their items are unknown");
  await render(view([], { unavailable: ["Meeting settings"] }));
  expect(container.textContent).toContain("No items reported by available sources.");
  expect(container.textContent).toContain("Their items are unknown");
});

it("requires confirmation and cancellation never stops an item", async () => {
  const onStop = await render(view([item()]));
  await click("Stop Send the budget");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "Stop Send the budget?",
  );
  expect(onStop).not.toHaveBeenCalled();
  await click("Cancel");
  expect(document.querySelector('[role="alertdialog"]:not([data-closed])')).toBeNull();
  expect(onStop).not.toHaveBeenCalled();
});

it("Escape cancels the real dialog without stopping", async () => {
  const onStop = await render(view([item()]));
  await click("Stop Send the budget");
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(document.querySelector('[role="alertdialog"]:not([data-closed])')).toBeNull();
  expect(onStop).not.toHaveBeenCalled();
});

it("passes the exact opaque version and announces the confirmed server outcome", async () => {
  const selected = item();
  const onStop = await render(view([selected]));
  await click("Stop Send the budget");
  await click("Confirm stop");
  expect(onStop).toHaveBeenCalledExactlyOnceWith(selected);
  expect(onStop.mock.calls[0]?.[0].version).toBe("opaque:revision/abc");
  expect(document.querySelector('[role="alertdialog"]:not([data-closed])')).toBeNull();
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
    "Stopped the reminder.",
  );
});

it("explains that running Harness work cannot be recalled and a stop request is not a stopped task", async () => {
  const onStop = vi.fn(async (_item: DotHandlingItem) =>
    result({
      kind: "harness-assignment",
      outcome: "stop-requested",
      stopped: false,
      message: "Stop requested; execution is still running.",
    }),
  );
  await render(view([item({ kind: "harness-assignment", state: "working" })]), onStop);
  await click("Stop Send the budget");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "cannot be recalled",
  );
  await click("Confirm stop");
  const notice = container.querySelector('[aria-live="polite"]')?.textContent;
  expect(notice).toContain("Stop requested; execution is still running.");
  expect(notice).toContain("result may still return");
});

it("does not offer Stop when the backend omits it and preserves the backend reason", async () => {
  const onStop = await render(
    view([
      item({
        kind: "harness-assignment",
        state: "working",
        controls: ["open"],
        note: "Stop requested, but running work cannot be recalled.",
      }),
    ]),
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Stop requested, but running work cannot be recalled.");
  expect(onStop).not.toHaveBeenCalled();
});

it.each(["conflict", "not-stoppable"] as const)(
  "shows %s results as errors with refresh guidance",
  async (outcome) => {
    const onStop = vi.fn(async (_item: DotHandlingItem) =>
      result({ ok: false, stopped: false, outcome, message: "This item changed." }),
    );
    await render(view([item()]), onStop);
    await click("Stop Send the budget");
    await click("Confirm stop");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Refresh the handling view",
    );
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("");
  },
);

it("reports rejected HTTP 409 with refresh guidance and permits cancellation", async () => {
  const onStop = vi.fn(async (_item: DotHandlingItem): Promise<DotHandlingStopResult> => {
    throw Object.assign(new Error("The item changed on the server."), { status: 409 });
  });
  await render(view([item()]), onStop);
  await click("Stop Send the budget");
  await click("Confirm stop");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "The item changed on the server.",
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Refresh the handling view",
  );
  await click("Cancel");
  expect(document.querySelector('[role="alertdialog"]:not([data-closed])')).toBeNull();
});

it("blocks confirmation if polling changes the version or removes the stop control", async () => {
  const onStop = await render(view([item()]));
  await click("Stop Send the budget");
  await render(view([item({ version: "new/opaque:revision" })]), onStop);
  expect(button("Confirm stop").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Refresh");
  await click("Confirm stop");
  expect(onStop).not.toHaveBeenCalled();
  await click("Cancel");
  await render(view([item()]), onStop);
  await click("Stop Send the budget");
  await render(view([item({ controls: ["open"], note: "Stop already requested." })]), onStop);
  expect(button("Confirm stop").disabled).toBe(true);
  await click("Confirm stop");
  expect(onStop).not.toHaveBeenCalled();
});

it("keeps an in-flight action busy, prevents duplicate stops, and announces failures", async () => {
  let rejectStop!: (cause: Error) => void;
  const pending = new Promise<DotHandlingStopResult>((_resolve, reject) => {
    rejectStop = reject;
  });
  const onStop = vi.fn((_item: DotHandlingItem) => pending);
  await render(view([item()]), onStop);
  await click("Stop Send the budget");
  await click("Confirm stop");
  expect(button("Stopping…").disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  expect(document.querySelector('[role="alertdialog"] [role="status"]')?.textContent).toBe(
    "Stopping…",
  );
  await click("Stopping…");
  expect(onStop).toHaveBeenCalledTimes(1);
  await act(async () => rejectStop(new Error("Network unavailable. Try again later.")));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Network unavailable. Try again later.",
  );
  expect(button("Confirm stop").disabled).toBe(false);
  expect(button("Cancel").disabled).toBe(false);
});
