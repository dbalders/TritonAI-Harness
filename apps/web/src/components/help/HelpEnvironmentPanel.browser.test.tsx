import { EnvironmentId, type HelpContext } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";
import { HelpEnvironmentPanel } from "./HelpEnvironmentPanel";
import { HELP_SETTINGS_LINKS } from "./helpLinks";

const context: HelpContext = {
  capturedAt: "2026-10-22T12:00:00Z",
  environmentId: EnvironmentId.make("host"),
  environmentName: "Test host",
  version: "0.3.1",
  platform: "darwin",
  mode: "desktop",
  paths: [],
  modelLabel: "Configured text generation model",
  providers: Array.from({ length: 9 }, (_, index) => ({
    id: `disabled-${index}`,
    name: `Disabled provider ${index}`,
    driver: "codex",
    enabled: false,
    status: "disabled",
    authenticated: null,
  })),
  diagnostics: {
    recordCount: 0,
    failureCount: 0,
    slowSpanCount: 0,
    partial: false,
    recentFailures: [],
  },
};

const renderPanel = (panelContext: HelpContext, onRefresh: () => void) =>
  render(
    <HelpEnvironmentPanel
      context={panelContext}
      pending={false}
      canRefresh
      notice={null}
      onRefresh={onRefresh}
    />,
  );
const disclosure = (screen: Screen, label: string) =>
  [...screen.container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(label),
  )!;
const link = (screen: Screen, label: string) =>
  [...screen.container.querySelectorAll("a")].find((node) => node.textContent === label);

it("starts closed with recovery links in view, keeps disabled providers collapsed, and refreshes only on request", async () => {
  const refresh = vi.fn();
  await using screen = await renderPanel(context, refresh);
  const environment = disclosure(screen, "This environment");
  expect(environment.getAttribute("aria-expanded")).toBe("false");
  expect(screen.container.textContent).not.toContain("Test host");
  // Collapsing the snapshot never hides how fresh it is or the way to recover without Help.
  expect(screen.container.textContent).toContain("Captured");
  for (const { label, to } of HELP_SETTINGS_LINKS) {
    expect(link(screen, label)?.getAttribute("href")).toBe(to);
  }
  await act(() => environment.click());
  expect(environment.getAttribute("aria-expanded")).toBe("true");
  expect(screen.container.textContent).toContain("Test host");
  expect(screen.container.textContent).toContain("No providers are enabled.");
  expect(link(screen, "Open Providers")?.getAttribute("href")).toBe("/settings/providers");
  expect(screen.container.textContent).toContain("Disabled providers (9)");
  expect(screen.container.textContent).not.toContain("Disabled provider 0");
  expect(screen.container.textContent).toContain("reported / cached");
  expect(screen.container.textContent).toContain("does not retest providers");
  expect(refresh).not.toHaveBeenCalled();
  await act(() => disclosure(screen, "Disabled providers (9)").click());
  expect(screen.container.textContent).toContain("Disabled provider 0");
  expect(screen.container.textContent).toContain("Disabled provider 8");
  await act(() =>
    screen.container
      .querySelector<HTMLButtonElement>('[aria-label="Refresh environment snapshot"]')!
      .click(),
  );
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(environment.getAttribute("aria-expanded")).toBe("true");
});

it("shows enabled provider status first while keeping disabled inventory behind its disclosure", async () => {
  await using screen = await renderPanel(
    {
      ...context,
      providers: [
        ...context.providers,
        {
          id: "ready",
          name: "Enabled provider",
          driver: "codex",
          enabled: true,
          status: "ready",
          authenticated: true,
        },
      ],
    },
    vi.fn(),
  );
  await act(() => disclosure(screen, "This environment").click());
  expect(screen.container.textContent).toContain("Enabled provider");
  expect(screen.container.textContent).toContain("ready · authentication reported");
  expect(screen.container.textContent).not.toContain("No providers are enabled.");
  expect(screen.container.textContent).not.toContain("Disabled provider 0");
});
