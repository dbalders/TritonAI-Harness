import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../../test/render";

vi.mock(import("../../hooks/useMediaQuery"), async (original) => ({
  ...(await original()),
  useIsMobile: () => false,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => null) as never,
  usePullRequestsSupported: () => false,
}));
vi.mock(import("./SidebarUpdatePill"), async (original) => ({
  ...(await original()),
  SidebarUpdatePill: (() => null) as never,
  SidebarUpdateArchitectureWarning: (() => null) as never,
}));
vi.mock(import("./SidebarProviderUpdatePill"), async (original) => ({
  ...(await original()),
  SidebarProviderUpdatePill: (() => null) as never,
}));
vi.mock(import("./SidebarThreadUndoNotice"), async (original) => ({
  ...(await original()),
  SidebarThreadUndoNotice: (() => null) as never,
}));

import { SidebarProvider, useSidebar } from "../ui/sidebar";
import { isSidebarUtilityPage, MainAppLocationTracker } from "./mainAppLocation";
import { SidebarUtilityMenu } from "./SidebarChrome";

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

const sidebarState = (screen: Screen) =>
  screen.container.querySelector("[data-sidebar-state]")?.getAttribute("data-sidebar-state");

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
    using _cookies = stubGlobal("cookieStore", { set: vi.fn(async () => undefined) });
    const rootRoute = createRootRoute({ component: TestShell });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({ getParentRoute: () => rootRoute, path: "$" }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/help"] }),
    });
    await router.load();
    // Every app URL must resolve to the shell, which the helper's root-only router cannot do.
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    const visit = async (href: string) => {
      await act(() => router.navigate({ href }));
      expect(router.state.location.href).toBe(href);
    };
    const click = async (label: string) => {
      const element = [...screen.container.querySelectorAll<HTMLElement>("button, a")].find(
        (node) => node.textContent === label,
      );
      expect(element).toBeDefined();
      await act(() => element!.click());
    };
    const expectHelpAboveBack = () => {
      expect(
        [...screen.container.querySelectorAll('[data-sidebar="menu-button"]')].map(
          (node) => node.textContent,
        ),
      ).toEqual(["Help", "Back"]);
    };

    expectHelpAboveBack();
    await click("Back");
    expect(router.state.location.href).toBe("/");

    const threadHref = "/remote/thread-1?view=conversation#latest";
    await visit(threadHref);
    await click("Toggle sidebar");
    expect(sidebarState(screen)).toBe("collapsed");
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
    expect(sidebarState(screen)).toBe("collapsed");
    await click("Toggle sidebar");
    expect(sidebarState(screen)).toBe("expanded");

    await visit("/local/thread-2");
    await visit("/help");
    await click("Back");
    expect(router.state.location.href).toBe("/local/thread-2");
  });
});
