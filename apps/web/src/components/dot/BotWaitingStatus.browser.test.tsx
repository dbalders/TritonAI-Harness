import { act, render as renderTest, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { BotWaitingStatus } from "./BotWaitingStatus";
import {
  nextWake,
  usableWaiting,
  type DotWaitingAction,
  type DotWaitingStatus,
} from "./dotWaiting";

const now = Date.parse("2026-10-13T16:00:00.000Z");
const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const claimed: DotWaitingStatus = {
  code: "claimed",
  on: "computer",
  phase: "claimed",
  text: "The selected task was claimed by your task computer. No result has come back yet.",
  confirmed: { at: iso(-1), what: "Synthetic Mac checked in" },
  next: [
    { kind: "event", what: "Its result returns here when the computer reports it" },
    { kind: "check", at: iso(5), what: "Check the selected task" },
  ],
  changesAt: iso(2),
};

let root: Screen;
let container: HTMLDivElement;
async function setupTest() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  container = document.createElement("div");
  document.body.append(container);
  root = await renderTest(null, { container, router: false });

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

const text = () => container.textContent ?? "";

describe("waiting status", async () => {
  it("says who it waits on, why, what last confirmed it and its real next check, then turns overdue on one wake", async () => {
    await using _test = await setupTest();
    await act(async () =>
      root.rerender(<BotWaitingStatus waiting={claimed} subject="Budget review" timezone="UTC" />),
    );
    const group = container.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("Status of Budget review");
    expect(text()).toContain("Waiting on your task computer");
    expect(text()).toContain("No result has come back yet.");
    expect(text()).toContain("Last confirmed: Synthetic Mac checked in");
    expect(text()).toContain("Next: Its result returns here when the computer reports it");
    expect(text()).toContain("Next check: Check the selected task ·");
    expect(text()).not.toContain("overdue");
    // One pending wake, not a repaint interval.
    expect(vi.getTimerCount()).toBe(1);

    // No new data arrives: at the claim's own change time the status says it may be out of date.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
    });
    expect(text()).toContain("This was expected to change at");
    expect(vi.getTimerCount()).toBe(1);

    // The scheduled check passes: it is shown as overdue, never as upcoming.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(text()).toContain("Next check overdue: Check the selected task was due");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("states plainly when nothing is scheduled and offers the recovery only when allowed", async () => {
    await using _test = await setupTest();
    const decide: DotWaitingAction = {
      kind: "decline",
      label: "Decline it",
      target: { kind: "approval", id: "approval-1" },
    };
    const waiting: DotWaitingStatus = {
      code: "decline-only",
      on: "you",
      text: "This request can't start: you changed the requirement. Approving won't run it; decline it.",
      action: decide,
      next: [{ kind: "none", what: "No more checks; it waits for your decision." }],
    };
    const onAction = vi.fn();
    await act(async () =>
      root.rerender(
        <BotWaitingStatus waiting={waiting} subject="Rebuild summary" onAction={onAction} />,
      ),
    );
    expect(text()).toContain("Waiting on you");
    expect(text()).toContain("Next check: none. No more checks; it waits for your decision.");
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Decline it",
    )!;
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledWith(decide);
    await act(async () =>
      root.rerender(
        <BotWaitingStatus
          waiting={waiting}
          subject="Rebuild summary"
          onAction={onAction}
          canAct={() => false}
        />,
      ),
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("drops malformed explanations so older or partial responses keep their own wording", async () => {
    await using _test = await setupTest();
    expect(usableWaiting(undefined)).toBeUndefined();
    expect(usableWaiting({ code: "queued", on: "you", text: "", next: [] })).toBeUndefined();
    expect(
      usableWaiting({
        code: "queued",
        on: "elsewhere",
        text: "Queued.",
        next: [{ kind: "none", what: "x" }],
      }),
    ).toBeUndefined();
    expect(usableWaiting(claimed)).toBe(claimed);
    expect(nextWake(claimed, now)).toBe(Date.parse(iso(2)));
    expect(
      nextWake(
        { code: "queued", on: "bot", text: "Queued.", next: [{ kind: "event", what: "x" }] },
        now,
      ),
    ).toBeUndefined();
  });
});
