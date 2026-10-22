// @vitest-environment jsdom
import { EnvironmentId, type HelpContext } from "@t3tools/contracts";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HelpEnvironmentPanel } from "./HelpEnvironmentPanel";
import { HELP_SETTINGS_LINKS } from "./helpLinks";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: Omit<ComponentProps<"a">, "href"> & { to: string }) =>
    createElement("a", { ...props, href: to }, children),
}));

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
let root: Root;
let container: HTMLDivElement;
const refresh = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  refresh.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("starts closed with recovery links in view, keeps disabled providers collapsed, and refreshes only on request", async () => {
  await act(() =>
    root.render(
      <HelpEnvironmentPanel
        context={context}
        pending={false}
        canRefresh
        notice={null}
        onRefresh={refresh}
      />,
    ),
  );
  const environmentDisclosure = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("This environment"),
  )!;
  const link = (label: string) =>
    [...container.querySelectorAll("a")].find((node) => node.textContent === label);
  expect(environmentDisclosure.getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain("Test host");
  // Collapsing the snapshot never hides how fresh it is or the way to recover without Help.
  expect(container.textContent).toContain("Captured");
  for (const { label, to } of HELP_SETTINGS_LINKS) {
    expect(link(label)?.getAttribute("href")).toBe(to);
  }
  await act(() => environmentDisclosure.click());
  expect(environmentDisclosure.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("Test host");
  expect(container.textContent).toContain("No providers are enabled.");
  expect(link("Open Providers")?.getAttribute("href")).toBe("/settings/providers");
  expect(container.textContent).toContain("Disabled providers (9)");
  expect(container.textContent).not.toContain("Disabled provider 0");
  expect(container.textContent).toContain("reported / cached");
  expect(container.textContent).toContain("does not retest providers");
  expect(refresh).not.toHaveBeenCalled();
  const disclosure = [...container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Disabled providers (9)"),
  )!;
  await act(() => disclosure.click());
  expect(container.textContent).toContain("Disabled provider 0");
  expect(container.textContent).toContain("Disabled provider 8");
  await act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Refresh environment snapshot"]')!
      .click(),
  );
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(environmentDisclosure.getAttribute("aria-expanded")).toBe("true");
});

it("shows enabled provider status first while keeping disabled inventory behind its disclosure", async () => {
  const mixed: HelpContext = {
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
  };
  await act(() =>
    root.render(
      <HelpEnvironmentPanel
        context={mixed}
        pending={false}
        canRefresh
        notice={null}
        onRefresh={refresh}
      />,
    ),
  );
  await act(() =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent?.includes("This environment"))!
      .click(),
  );
  expect(container.textContent).toContain("Enabled provider");
  expect(container.textContent).toContain("ready · authentication reported");
  expect(container.textContent).not.toContain("No providers are enabled.");
  expect(container.textContent).not.toContain("Disabled provider 0");
});
