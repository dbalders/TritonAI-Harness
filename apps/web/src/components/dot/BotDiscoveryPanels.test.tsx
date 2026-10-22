// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BotCapabilitiesPanel, BotMicrosoftBanner } from "./BotDiscoveryPanels";
import type { DotCapability, DotMicrosoftHealth, DotMicrosoftState } from "./dotDiscovery";

const connectionsUrl = "https://bot.example.test/connections";
const since = "2026-10-08T12:00:00Z";
const health = (areas: DotMicrosoftHealth["areas"]): DotMicrosoftHealth => ({
  userId: "synthetic-owner",
  version: 1,
  generation: since,
  areas,
});
const areaHealth = (status: "connected" | "needs-reconnect" | "degraded") => ({
  status,
  since,
  generation: since,
});

const capabilities: readonly DotCapability[] = [
  {
    id: "opaque-available-id",
    description: "Keep a note for later.",
    examples: ["Remember the project deadline.", "Show my notes."],
    availability: { status: "available" },
  },
  {
    id: "opaque-connection-id",
    description: "Read your calendar.",
    examples: ["What meetings do I have today?"],
    availability: {
      status: "needs-connection",
      how: "Open /connections and connect calendar access.",
    },
  },
  {
    id: "opaque-restricted-id",
    description: "Read Outlook email.",
    examples: ["Find the budget email."],
    availability: {
      status: "not-available-for-account",
      why: "Microsoft access is not enabled for this account.",
    },
  },
];

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(component: ReactNode) {
  await act(async () => root.render(component));
}
async function renderMicrosoft(microsoft: DotMicrosoftState | undefined) {
  await render(<BotMicrosoftBanner microsoft={microsoft} connectionsUrl={connectionsUrl} />);
}

describe("Microsoft reconnect discovery", () => {
  it("does not infer a reconnect from absent or legacy account availability", async () => {
    for (const microsoft of [
      undefined,
      {},
      { available: true },
      { available: false, message: "Microsoft access is not enabled for this account." },
      { message: "Connection status could not be checked." },
      { health: health({}) },
    ]) {
      await renderMicrosoft(microsoft);
      expect(container.textContent).toBe("");
      expect(container.querySelector("a")).toBeNull();
    }
  });

  it("does not offer reconnect for connected or temporarily degraded health", async () => {
    for (const status of ["connected", "degraded"] as const) {
      await renderMicrosoft({ health: health({ calendar: areaHealth(status) }) });
      expect(container.textContent).toBe("");
      expect(container.querySelector("a")).toBeNull();
    }
  });

  it("offers the existing connections flow only for areas needing reconnect", async () => {
    await renderMicrosoft({
      health: health({
        calendar: areaHealth("needs-reconnect"),
        attention: areaHealth("degraded"),
        onedrive: areaHealth("needs-reconnect"),
        todo: areaHealth("connected"),
      }),
    });
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Microsoft access needs reconnecting");
    expect(status?.textContent).toContain("Calendar, OneDrive");
    expect(status?.textContent).not.toContain("Inbox");
    expect(status?.textContent).not.toContain("To Do");
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Reconnect Microsoft");
    link.focus();
    expect(document.activeElement).toBe(link);
    let destination: string | undefined;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      destination = link.href;
    });
    await act(async () => link.click());
    expect(destination).toBe(connectionsUrl);
  });

  it("keeps explicit account restrictions stronger than a leftover reconnect status", async () => {
    const reconnect = health({ calendar: areaHealth("needs-reconnect") });
    await renderMicrosoft({ health: reconnect });
    expect(container.textContent).toContain("Reconnect Microsoft");
    await renderMicrosoft({ available: false, message: "Account restricted.", health: reconnect });
    expect(container.textContent).toBe("");
    expect(container.querySelector("a")).toBeNull();
  });

  it("removes a reconnect notice when the next state is degraded, connected, or absent", async () => {
    for (const microsoft of [
      { health: health({ calendar: areaHealth("degraded") }) },
      { health: health({ calendar: areaHealth("connected") }) },
      undefined,
    ]) {
      await renderMicrosoft({ health: health({ calendar: areaHealth("needs-reconnect") }) });
      expect(container.querySelector("a")).not.toBeNull();
      await renderMicrosoft(microsoft);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector("a")).toBeNull();
    }
  });
});

describe("capability discovery", () => {
  it("hides discovery when the service does not report the new field", async () => {
    await render(<BotCapabilitiesPanel capabilities={capabilities} />);
    expect(container.querySelector("summary")?.textContent).toBe("What I can do");
    await render(<BotCapabilitiesPanel capabilities={undefined} />);
    expect(container.textContent).toBe("");
  });

  it("opens and closes the native disclosure through its focused summary", async () => {
    await render(<BotCapabilitiesPanel capabilities={capabilities} />);
    const details = container.querySelector("details")!;
    const summary = container.querySelector("summary")!;
    expect(details.open).toBe(false);
    summary.focus();
    expect(document.activeElement).toBe(summary);
    await act(async () => summary.click());
    expect(details.open).toBe(true);
    const items = details.querySelectorAll(":scope > div > ul > li");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain("Keep a note for later.");
    expect(items[0]?.textContent).toContain("Available");
    expect(items[0]?.textContent).toContain("Remember the project deadline.");
    expect(items[0]?.textContent).toContain("Show my notes.");
    expect(items[1]?.textContent).toContain("Needs connection");
    expect(items[1]?.textContent).toContain("Open /connections and connect calendar access.");
    expect(items[1]?.textContent).toContain("What meetings do I have today?");
    expect(items[2]?.textContent).toContain("Not available for your account");
    expect(items[2]?.textContent).toContain("Microsoft access is not enabled for this account.");
    expect(container.textContent).not.toContain("opaque-");
    await act(async () => summary.click());
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });

  it("keeps a discovery error readable while the empty list remains collapsed", async () => {
    const message = "Connection status could not be checked; availability is unknown.";
    await render(<BotCapabilitiesPanel capabilities={[]} capabilitiesError={message} />);
    const details = container.querySelector("details")!;
    const status = container.querySelector('[role="status"]')!;
    expect(details.open).toBe(false);
    expect(status.textContent).toBe(message);
    expect(status.closest("details")).toBeNull();
    await act(async () => container.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("No capabilities reported.");
    expect(container.textContent).not.toContain("Available");
  });

  it("shows an error even when capabilities are absent, then clears it on recovery", async () => {
    await render(
      <BotCapabilitiesPanel capabilities={undefined} capabilitiesError="Discovery unavailable." />,
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Discovery unavailable.");
    expect(container.querySelector("details")).toBeNull();
    await render(<BotCapabilitiesPanel capabilities={capabilities} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => container.querySelector("summary")!.click());
    expect(container.querySelector("details")!.open).toBe(true);
    expect(container.textContent).toContain("Keep a note for later.");
  });

  it("updates availability and service guidance without inventing capability names", async () => {
    await render(<BotCapabilitiesPanel capabilities={[capabilities[1]!]} />);
    await act(async () => container.querySelector("summary")!.click());
    expect(container.textContent).toContain("Needs connection");
    await render(
      <BotCapabilitiesPanel
        capabilities={[
          { ...capabilities[1]!, availability: { status: "available" }, examples: [] },
        ]}
      />,
    );
    expect(container.querySelector("details")!.open).toBe(true);
    expect(container.textContent).toContain("Available");
    expect(container.textContent).not.toContain("Needs connection");
    expect(container.textContent).not.toContain("Open /connections");
    expect(container.textContent).not.toContain("Example prompts");
    expect(container.textContent).not.toContain("opaque-");
  });
});
