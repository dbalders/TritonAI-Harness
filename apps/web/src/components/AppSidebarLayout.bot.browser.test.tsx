import "../index.css";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ServerBotTaskComputerStatus,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  settings: null as ClientSettings | null,
  local: null as ServerBotTaskComputerStatus | null,
  stop: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: (select: (settings: ClientSettings) => unknown) => select(state.settings!),
  useClientSettingsHydrated: () => true,
  useLegacySidebarEnabled: () => false,
  useEnvironmentIdentificationMode: () => "none",
  usePrimarySettingsAvailable: () => true,
  updateClientSettings: state.update,
}));
vi.mock("../hooks/useThreadVisitedMigration", () => ({ useThreadVisitedMigration: () => {} }));
vi.mock("../hooks/useThreadRouteTarget", async (original) => ({
  ...(await original<typeof import("../hooks/useThreadRouteTarget")>()),
  useThreadRouteRef: () => null,
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [],
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () => "own-harness",
  usePrimaryEnvironment: () => null,
}));
vi.mock("../state/server", async (original) => {
  const source = await original<typeof import("../state/server")>();
  return {
    ...source,
    serverEnvironment: {
      ...source.serverEnvironment,
      stopBotTaskComputer: {},
      botTaskComputer: vi.fn(),
    },
  };
});
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: state.local, refresh: state.refresh }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.stop }));
vi.mock("./settings/useScopedSettings", async (original) => ({
  ...(await original<typeof import("./settings/useScopedSettings")>()),
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.update,
}));
// Keep the real application/sidebar shell and real collapsed Experimental section.
// Thread lists and unrelated navigation/projection effects have no role in this permission test.
vi.mock("./Sidebar", () => ({ default: () => <span>Thread list</span> }));
vi.mock("./LegacySidebar", () => ({ default: () => <span>Legacy thread list</span> }));
vi.mock("./settings/SettingsSidebarNav", () => ({
  SettingsSidebarNav: () => <span>Settings navigation</span>,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarBrandWidthProbe: () => null,
  SidebarChromeHeader: () => null,
}));
vi.mock("./sidebar/mainAppLocation", () => ({ MainAppLocationTracker: () => null }));
vi.mock("./SidebarStageBackdrop", async (original) => ({
  ...(await original<typeof import("./SidebarStageBackdrop")>()),
  useSidebarStageBackdropVariant: () => null,
}));

import { AppSidebarLayout } from "./AppSidebarLayout";
import { ExperimentalFeaturesSection } from "./settings/SettingsPanels";
import { saveDotSession, readDotSession } from "./dot/dotClient";

const currentService = "https://current.example.test";
const earlierService = "https://earlier.example.test";
function setup() {
  state.settings = {
    ...DEFAULT_CLIENT_SETTINGS,
    tritonAiBotEnabled: false,
    tritonAiBotUrl: currentService,
  };
  state.local = { state: "running", apiUrl: earlierService } as ServerBotTaskComputerStatus;
  state.stop.mockReset();
  state.stop.mockImplementation(async () => {
    state.local = { state: "off", apiUrl: null } as ServerBotTaskComputerStatus;
    return { _tag: "Success" };
  });
  state.update.mockReset();
  state.update.mockImplementation(async (patch) => Object.assign(state.settings!, patch));
  state.refresh.mockReset();
  sessionStorage.clear();
  return {
    [Symbol.dispose]() {
      vi.restoreAllMocks();
      sessionStorage.clear();
    },
  };
}

it("shows and stops an earlier pairing in the real app layout while Experimental stays collapsed", async () => {
  using _test = setup();
  const fetch = vi.spyOn(globalThis, "fetch");
  saveDotSession(sessionStorage, currentService, {
    ownerToken: "synthetic-other-service-owner",
    email: "own@example.test",
    expiresAt: 4_000_000_000,
  });
  await using screen = await render(
    <AppSidebarLayout>
      <main>
        <ExperimentalFeaturesSection />
      </main>
    </AppSidebarLayout>,
    { router: "/settings" },
  );
  const experimental = screen.container.querySelector("#experimental-features")!;
  expect(experimental.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  expect(screen.container.querySelector('[aria-label="TritonAI Bot (experimental)"]')).toBeNull();
  const notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
  expect(notice.textContent).toContain("Bot tasks are still allowed");
  expect(notice.closest("[data-app-sidebar]")).toBeNull();
  expect(getComputedStyle(notice).position).toBe("fixed");
  expect(notice.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(state.stop).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => (notice.querySelector("button") as HTMLButtonElement).click());
  expect(state.stop).toHaveBeenCalledWith({
    environmentId: "own-harness",
    input: { apiUrl: earlierService, ownerToken: null },
  });
  expect(state.settings!.tritonAiBotEnabled).toBe(false);
  expect(screen.container.querySelector('aside[aria-label="Bot task permission"]')).toBeNull();
  expect(experimental.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
});

it("keeps the global Stop visible with the main sidebar hidden, and recovers after a failed stop", async () => {
  using _test = setup();
  saveDotSession(sessionStorage, currentService, {
    ownerToken: "synthetic-other-service-owner",
    email: "own@example.test",
    expiresAt: 4_000_000_000,
  });
  state.stop.mockRejectedValueOnce(new Error("Harness is offline"));
  await using screen = await render(
    <AppSidebarLayout>
      <main>Conversation</main>
    </AppSidebarLayout>,
  );
  await userEvent.click(screen.container.querySelector('[aria-label="Toggle main sidebar"]')!);
  let notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
  expect(notice.getBoundingClientRect().width).toBeGreaterThan(0);
  await act(async () => (notice.querySelector("button") as HTMLButtonElement).click());
  expect(notice.querySelector('[role="alert"]')?.textContent).toBe("Harness is offline");
  expect((notice.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  expect(readDotSession(sessionStorage, currentService)).not.toBeNull();
  expect(state.update).not.toHaveBeenCalled();
  await act(async () => (notice.querySelector("button") as HTMLButtonElement).click());
  notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
  expect(notice).toBeNull();
  expect(state.stop).toHaveBeenCalledTimes(2);
  expect(state.settings!.tritonAiBotEnabled).toBe(false);
});
