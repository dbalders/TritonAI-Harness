// @vitest-environment jsdom

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { isSidebarUtilityPage, MainAppLocationTracker } from "./mainAppLocation";
import { SidebarUtilityMenu } from "./SidebarChrome";
import { SidebarProvider, useSidebar } from "../ui/sidebar";

vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => null,
  usePullRequestsSupported: () => false,
}));
vi.mock("./SidebarUpdatePill", () => ({
  SidebarUpdatePill: () => null,
  SidebarUpdateArchitectureWarning: () => null,
}));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => null }));

function SidebarToggle() {
  const { toggleSidebar } = useSidebar();
  return <button onClick={toggleSidebar}>Toggle sidebar</button>;
}

function TestShell() {
  return (
    <SidebarProvider>
      <MainAppLocationTracker />
      <SidebarUtilityMenu />
      <SidebarToggle />
    </SidebarProvider>
  );
}

describe("sidebar utility navigation", () => {
  it.each(["/help", "/settings", "/settings/general", "/usage", "/ideas", "/pull-requests"])(
    "keeps %s out of the remembered main app location",
    (pathname) => expect(isSidebarUtilityPage(pathname)).toBe(true),
  );

  it.each(["/", "/local/thread-1", "/project-brief/local/project-1", "/helpful/thread-1"])(
    "remembers main app route %s",
    (pathname) => expect(isSidebarUtilityPage(pathname)).toBe(false),
  );

  it("returns from Help to the latest main app URL across utility visits, with a direct-entry fallback", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("cookieStore", { set: vi.fn(async () => undefined) });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const rootRoute = createRootRoute({ component: TestShell });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({ getParentRoute: () => rootRoute, path: "$" }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/help"] }),
    });

    const visit = async (href: string) => {
      await act(() => router.navigate({ href }));
      expect(router.state.location.href).toBe(href);
    };
    const click = async (label: string) => {
      const element = [...container.querySelectorAll<HTMLElement>("button, a")].find(
        (element) => element.textContent === label,
      );
      expect(element).toBeDefined();
      await act(() => element!.click());
    };
    const expectHelpAboveBack = () => {
      expect(
        [...container.querySelectorAll('[data-sidebar="menu-button"]')].map(
          (element) => element.textContent,
        ),
      ).toEqual(["Help", "Back"]);
    };

    try {
      await router.load();
      await act(() => root.render(<RouterProvider router={router} />));

      expectHelpAboveBack();
      await click("Back");
      expect(router.state.location.href).toBe("/");

      const threadHref = "/remote/thread-1?view=conversation#latest";
      await visit(threadHref);
      await click("Toggle sidebar");
      expect(
        container.querySelector("[data-sidebar-state]")?.getAttribute("data-sidebar-state"),
      ).toBe("collapsed");
      await click("Help");
      expect(router.state.location.href).toBe("/help");
      await visit("/settings/general");
      expectHelpAboveBack();
      await click("Help");
      expect(router.state.location.href).toBe("/help");
      await visit("/usage");
      expectHelpAboveBack();
      await click("Help");
      expect(router.state.location.href).toBe("/help");
      await click("Back");
      expect(router.state.location.href).toBe(threadHref);
      expect(
        container.querySelector("[data-sidebar-state]")?.getAttribute("data-sidebar-state"),
      ).toBe("collapsed");
      await click("Toggle sidebar");
      expect(
        container.querySelector("[data-sidebar-state]")?.getAttribute("data-sidebar-state"),
      ).toBe("expanded");

      await visit("/local/thread-2");
      await visit("/help");
      await click("Back");
      expect(router.state.location.href).toBe("/local/thread-2");
    } finally {
      await act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
