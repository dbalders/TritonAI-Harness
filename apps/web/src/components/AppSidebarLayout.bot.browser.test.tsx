import "../index.css";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { Cause } from "effect";
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
  listeners: new Set<() => void>(),
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
// SettingsRow's Harness permission reads can leave primary discovery running
// after an earlier settings render unmounts, racing the Bot zero-fetch assertions.
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: () => false,
  useEnvironmentsWithScope: () => new Set(),
}));
vi.mock("../state/server", async (original) => {
  const source = await original<typeof import("../state/server")>();
  const { Atom } = await import("effect/reactivity");
  const { mergeWithDefaultKeybindings } = await import("@t3tools/shared/keybindings");
  return {
    ...source,
    primaryServerKeybindingsAtom: Atom.make(mergeWithDefaultKeybindings([])),
    serverEnvironment: {
      ...source.serverEnvironment,
      stopBotTaskComputer: {},
      botTaskComputer: vi.fn(),
    },
  };
});
vi.mock("../state/query", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<typeof import("../state/query")>()),
    useEnvironmentQuery: () => ({
      data: useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.local,
      ),
      refresh: state.refresh,
    }),
  };
});
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
import { BotOptInSettings } from "./settings/BotOptInSettings";
import { DotClient, saveDotSession, readDotSession } from "./dot/dotClient";

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
  state.listeners.clear();
  sessionStorage.clear();
  vi.spyOn(DotClient.prototype, "signOut").mockResolvedValue({ ok: true });
  return {
    [Symbol.dispose]() {
      vi.restoreAllMocks();
      sessionStorage.clear();
    },
  };
}

async function showNoticeDetails(notice: Element) {
  await act(() => notice.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
}

it.each(["unknown", "allowed"] as const)(
  "keeps the %s warning while collapsed details let page actions receive pointer clicks",
  async (permission) => {
    using _test = setup();
    state.settings = { ...state.settings!, tritonAiBotEnabled: permission === "unknown" };
    state.local = {
      state: permission === "unknown" ? "error" : "running",
      apiUrl: permission === "unknown" ? null : currentService,
    } as ServerBotTaskComputerStatus;
    const settings = { ...state.settings };
    const pairing = state.local;
    const session = {
      ownerToken: "synthetic-current-owner",
      email: "own@example.test",
      expiresAt: 4_000_000_000,
    };
    saveDotSession(sessionStorage, currentService, session);
    using signOut = vi.spyOn(DotClient.prototype, "signOut");
    using fetch = vi.spyOn(globalThis, "fetch");
    const openBot = vi.fn();
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1100, 780);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previousViewport.width, previousViewport.height),
    };
    await using screen = await render(
      <AppSidebarLayout>
        <main className="min-w-0 flex-1 p-8 pt-48">
          <div className="flex justify-end">
            <button type="button" onClick={openBot}>
              Open TritonAI Bot
            </button>
          </div>
        </main>
      </AppSidebarLayout>,
      { router: permission === "unknown" ? "/settings/tritonai-bot" : "/" },
    );
    await userEvent.click(screen.container.querySelector('[aria-label="Toggle main sidebar"]')!);
    expect(
      screen.container
        .querySelector('[data-slot="sidebar-wrapper"]')
        ?.getAttribute("data-sidebar-state"),
    ).toBe("collapsed");
    const notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
    const summary = notice.querySelector('[role="status"]')!;
    expect(summary.textContent).toContain(
      permission === "unknown" ? "Bot task permission is unknown" : "Bot tasks are allowed",
    );
    const toggle = screen.getByRole("button", { name: "Show details", exact: true }).element();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const detailsId = toggle.getAttribute("aria-controls")!;
    expect(document.getElementById(detailsId)?.hidden).toBe(true);
    expect(notice.querySelectorAll("button")).toHaveLength(1);
    const pageAction = screen.getByRole("button", { name: "Open TritonAI Bot", exact: true });
    const actionRect = pageAction.element().getBoundingClientRect();
    expect(actionRect.width).toBeGreaterThan(0);
    expect(actionRect.height).toBeGreaterThan(0);
    const hitPageAction = () =>
      document.elementFromPoint(
        actionRect.left + actionRect.width / 2,
        actionRect.top + actionRect.height / 2,
      );
    expect(hitPageAction()).toBe(pageAction.element());
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide details");
    const disclosure = screen.getByText(/Stopping tasks here signs you out/).element();
    const stop = screen.getByRole("button", { name: "Stop Bot tasks here", exact: true });
    expect(disclosure.textContent).toContain("turns off Experimental Bot here");
    expect(disclosure.textContent).toContain("stops new assignments for every client");
    expect(disclosure.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      stop.element().getBoundingClientRect().top,
    );
    // The expanded notice really covers this control; collapsing must remove that obstruction.
    expect(notice.contains(hitPageAction())).toBe(true);
    await userEvent.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(document.getElementById(detailsId)?.querySelector("button")).toBeNull();
    expect(summary.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(hitPageAction()).toBe(pageAction.element());
    await userEvent.click(pageAction);
    expect(openBot).toHaveBeenCalledOnce();
    await userEvent.click(toggle);
    await userEvent.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await expect.element(stop).toBeEnabled();
    expect(
      screen
        .getByText(/Stopping tasks here signs you out/)
        .element()
        .getBoundingClientRect().height,
    ).toBeGreaterThan(0);
    if (permission === "allowed")
      await expect
        .element(screen.getByRole("button", { name: "Turn on Experimental Bot" }))
        .toBeEnabled();
    expect(state.settings).toEqual(settings);
    expect(state.local).toBe(pairing);
    expect(readDotSession(sessionStorage, currentService)).toEqual(session);
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

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
  await showNoticeDetails(notice);
  expect(notice.textContent).toContain("Bot tasks are allowed");
  expect(notice.closest("[data-app-sidebar]")).toBeNull();
  expect(getComputedStyle(notice).position).toBe("fixed");
  expect(notice.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(state.stop).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  await act(async () =>
    (notice.querySelector("button:not([aria-expanded])") as HTMLButtonElement).click(),
  );
  expect(state.stop).toHaveBeenCalledWith({
    environmentId: "own-harness",
    input: { apiUrl: earlierService, ownerToken: null },
  });
  expect(state.settings!.tritonAiBotEnabled).toBe(false);
  expect(screen.container.querySelector('aside[aria-label="Bot task permission"]')).toBeNull();
  expect(experimental.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
});

it.each(["focus", "visibilitychange"])(
  "discovers a current pairing once on %s even with a second settings consumer mounted",
  async (event) => {
    using _test = setup();
    state.local = { state: "off", apiUrl: null } as ServerBotTaskComputerStatus;
    await using screen = await render(
      <AppSidebarLayout>
        <main>
          <BotOptInSettings />
        </main>
      </AppSidebarLayout>,
      { router: "/settings" },
    );
    expect(screen.container.querySelector('aside[aria-label="Bot task permission"]')).toBeNull();
    expect(state.refresh).not.toHaveBeenCalled();
    state.refresh.mockImplementation(() => {
      state.local = { state: "idle", apiUrl: currentService } as ServerBotTaskComputerStatus;
      for (const listener of state.listeners) listener();
    });
    using _visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(() => (event === "focus" ? window : document).dispatchEvent(new Event(event)));
    expect(state.refresh).toHaveBeenCalledOnce();
    const notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
    expect(notice.textContent).toContain("Bot tasks are allowed on this Harness");
    expect(state.settings!.tritonAiBotEnabled).toBe(false);
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    await screen.unmount();
    await act(() => (event === "focus" ? window : document).dispatchEvent(new Event(event)));
    expect(state.refresh).toHaveBeenCalledOnce();
  },
);

it("keeps the global Stop reachable with the main sidebar hidden, and recovers after a failed stop", async () => {
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
  await showNoticeDetails(notice);
  expect(notice.getBoundingClientRect().width).toBeGreaterThan(0);
  await act(async () =>
    (notice.querySelector("button:not([aria-expanded])") as HTMLButtonElement).click(),
  );
  expect(notice.querySelector('[role="alert"]')?.textContent).toBe("Harness is offline");
  expect((notice.querySelector("button:not([aria-expanded])") as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(readDotSession(sessionStorage, currentService)).not.toBeNull();
  expect(state.update).not.toHaveBeenCalled();
  await act(async () =>
    (notice.querySelector("button:not([aria-expanded])") as HTMLButtonElement).click(),
  );
  notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
  expect(notice).toBeNull();
  expect(state.stop).toHaveBeenCalledTimes(2);
  expect(state.settings!.tritonAiBotEnabled).toBe(false);
});

it("lets a second client enable Bot without stopping the shared current pairing, with Experimental closed and the sidebar hidden", async () => {
  using _test = setup();
  const pairing = { state: "running", apiUrl: currentService } as ServerBotTaskComputerStatus;
  state.local = pairing;
  const firstClientSettings = { ...state.settings!, tritonAiBotEnabled: true };
  state.settings = firstClientSettings;
  await using firstClient = await render(
    <AppSidebarLayout>
      <main>
        <ExperimentalFeaturesSection />
      </main>
    </AppSidebarLayout>,
    { router: "/settings" },
  );
  expect(firstClient.container.querySelector('aside[aria-label="Bot task permission"]')).toBeNull();
  await firstClient.unmount();

  // The second client's opt-in is independent; both clients see the same Harness pairing.
  state.settings = { ...DEFAULT_CLIENT_SETTINGS, tritonAiBotUrl: currentService };
  const session = {
    ownerToken: "synthetic-second-client-owner",
    email: "own@example.test",
    expiresAt: 4_000_000_000,
  };
  saveDotSession(sessionStorage, currentService, session);
  using signOut = vi.spyOn(DotClient.prototype, "signOut");
  using fetch = vi.spyOn(globalThis, "fetch");
  await using secondClient = await render(
    <AppSidebarLayout>
      <main>
        <ExperimentalFeaturesSection />
      </main>
    </AppSidebarLayout>,
    { router: "/settings" },
  );
  await userEvent.click(
    secondClient.container.querySelector('[aria-label="Toggle main sidebar"]')!,
  );
  const experimental = secondClient.container.querySelector("#experimental-features")!;
  expect(experimental.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  expect(
    secondClient.container.querySelector('[aria-label="TritonAI Bot (experimental)"]'),
  ).toBeNull();
  const notice = secondClient.container.querySelector('aside[aria-label="Bot task permission"]')!;
  await showNoticeDetails(notice);
  expect(notice.textContent).not.toMatch(/earlier|legacy/i);
  expect(notice.textContent).toContain("Experimental Bot is off in this app");
  expect(notice.closest("[data-app-sidebar]")).toBeNull();
  expect(notice.getBoundingClientRect().width).toBeGreaterThan(0);
  await act(async () =>
    Array.from(notice.querySelectorAll("button"))
      .find((button) => button.textContent === "Turn on Experimental Bot")!
      .click(),
  );
  expect(
    secondClient.container.querySelector('aside[aria-label="Bot task permission"]'),
  ).toBeNull();
  expect(state.settings!.tritonAiBotEnabled).toBe(true);
  expect(state.update).toHaveBeenCalledExactlyOnceWith({ tritonAiBotEnabled: true });
  expect(firstClientSettings.tritonAiBotEnabled).toBe(true);
  expect(state.local).toBe(pairing);
  expect(readDotSession(sessionStorage, currentService)).toEqual(session);
  expect(state.stop).not.toHaveBeenCalled();
  expect(signOut).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(experimental.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
});

it.each([false, true])(
  "keeps unknown permission global and shows recovery with local Bot enabled=%s",
  async (enabled) => {
    using _test = setup();
    state.settings = { ...state.settings!, tritonAiBotEnabled: enabled };
    state.local = { state: "error", apiUrl: null } as ServerBotTaskComputerStatus;
    using fetch = vi.spyOn(globalThis, "fetch");
    await using screen = await render(
      <AppSidebarLayout>
        <main>
          <ExperimentalFeaturesSection />
        </main>
      </AppSidebarLayout>,
      { router: "/settings" },
    );
    await userEvent.click(screen.container.querySelector('[aria-label="Toggle main sidebar"]')!);
    const experimental = screen.container.querySelector("#experimental-features")!;
    expect(experimental.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    const notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
    await showNoticeDetails(notice);
    expect(notice.textContent).toContain("permission on this Harness cannot currently be checked");
    expect(notice.textContent).toContain("Retrying automatically");
    expect(notice.textContent).not.toContain("Bot tasks are allowed");
    expect(notice.textContent).not.toContain("Turn on Experimental Bot");
    const stop = Array.from(notice.querySelectorAll("button")).find(
      (button) => button.textContent === "Stop Bot tasks here",
    )!;
    expect(stop.disabled).toBe(false);
    expect(notice.closest("[data-app-sidebar]")).toBeNull();
    expect(notice.getBoundingClientRect().width).toBeGreaterThan(0);
    // Query timing is covered by the actual atom test; deliver its recovered snapshot here.
    await act(() => {
      state.local = { state: "running", apiUrl: currentService } as ServerBotTaskComputerStatus;
      for (const listener of state.listeners) listener();
    });
    const recovered = screen.container.querySelector('aside[aria-label="Bot task permission"]');
    if (enabled) expect(recovered).toBeNull();
    else {
      expect(recovered!.textContent).toContain("Bot tasks are allowed on this Harness");
      expect(recovered!.textContent).toContain("Turn on Experimental Bot");
      expect(recovered!.closest("[data-app-sidebar]")).toBeNull();
    }
    expect(experimental.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("discloses the enabled unknown-permission Stop effects before stopping, signing out and disabling Bot in order", async () => {
  using _test = setup();
  state.settings = { ...state.settings!, tritonAiBotEnabled: true };
  state.local = { state: "error", apiUrl: null } as ServerBotTaskComputerStatus;
  const ownSession = {
    ownerToken: "synthetic-current-owner",
    email: "own@example.test",
    expiresAt: 4_000_000_000,
  };
  const otherSession = { ...ownSession, ownerToken: "synthetic-earlier-service-owner" };
  saveDotSession(sessionStorage, currentService, ownSession);
  saveDotSession(sessionStorage, earlierService, otherSession);
  const effects: string[] = [];
  let finishStop!: () => void;
  let finishSignOut!: () => void;
  using signOut = vi.spyOn(DotClient.prototype, "signOut").mockImplementation(async function (
    this: DotClient,
    session,
  ) {
    effects.push("sign out");
    expect(this.baseUrl).toBe(currentService);
    expect(session).toEqual(ownSession);
    expect(readDotSession(sessionStorage, currentService)).toEqual(ownSession);
    expect(state.settings!.tritonAiBotEnabled).toBe(true);
    return new Promise((resolve) => {
      finishSignOut = () => resolve({ ok: true });
    });
  });
  state.stop.mockImplementation(async () => {
    effects.push("stop");
    expect(readDotSession(sessionStorage, currentService)).toEqual(ownSession);
    expect(state.settings!.tritonAiBotEnabled).toBe(true);
    return new Promise((resolve) => {
      finishStop = () => {
        state.local = { state: "off", apiUrl: null } as ServerBotTaskComputerStatus;
        resolve({ _tag: "Success" });
      };
    });
  });
  state.update.mockImplementation(async (patch) => {
    effects.push("disable");
    expect(readDotSession(sessionStorage, currentService)).toBeNull();
    expect(readDotSession(sessionStorage, earlierService)).toBeNull();
    Object.assign(state.settings!, patch);
  });
  await using screen = await render(
    <AppSidebarLayout>
      <main>Conversation</main>
    </AppSidebarLayout>,
  );
  const notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
  await showNoticeDetails(notice);
  expect(notice.textContent).toContain("cannot currently be checked");
  expect(notice.textContent).toContain("signs you out of Bot in this app");
  expect(notice.textContent).toContain("turns off Experimental Bot here");
  expect(notice.textContent).toContain("stops new assignments for every client of this Harness");
  expect(notice.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(effects).toEqual([]);
  await act(async () =>
    (notice.querySelector("button:not([aria-expanded])") as HTMLButtonElement).click(),
  );
  expect(state.stop).toHaveBeenCalledExactlyOnceWith({
    environmentId: "own-harness",
    input: { apiUrl: currentService, ownerToken: ownSession.ownerToken },
  });
  expect(effects).toEqual(["stop"]);
  expect(signOut).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
  expect(state.settings!.tritonAiBotEnabled).toBe(true);
  expect(readDotSession(sessionStorage, currentService)).toEqual(ownSession);
  expect(readDotSession(sessionStorage, earlierService)).toEqual(otherSession);
  await act(async () => finishStop());
  expect(signOut).toHaveBeenCalledOnce();
  expect(effects).toEqual(["stop", "sign out"]);
  expect(state.update).not.toHaveBeenCalled();
  expect(readDotSession(sessionStorage, earlierService)).toEqual(otherSession);
  await act(async () => finishSignOut());
  expect(effects).toEqual(["stop", "sign out", "disable"]);
  expect(state.update).toHaveBeenCalledExactlyOnceWith({ tritonAiBotEnabled: false });
  expect(state.settings!.tritonAiBotEnabled).toBe(false);
  expect(readDotSession(sessionStorage, currentService)).toBeNull();
  expect(screen.container.querySelector('aside[aria-label="Bot task permission"]')).toBeNull();
});

it.each(["refused", "unreachable"])(
  "preserves enabled Bot and both service sessions when unknown-permission Stop is %s",
  async (failure) => {
    using _test = setup();
    state.settings = { ...state.settings!, tritonAiBotEnabled: true };
    const unknown = { state: "error", apiUrl: null } as ServerBotTaskComputerStatus;
    state.local = unknown;
    const ownSession = {
      ownerToken: "synthetic-current-owner",
      email: "own@example.test",
      expiresAt: 4_000_000_000,
    };
    const otherSession = { ...ownSession, ownerToken: "synthetic-earlier-service-owner" };
    saveDotSession(sessionStorage, currentService, ownSession);
    saveDotSession(sessionStorage, earlierService, otherSession);
    using signOut = vi.spyOn(DotClient.prototype, "signOut");
    if (failure === "refused")
      state.stop.mockResolvedValue({
        _tag: "Failure",
        cause: Cause.fail(new Error("Could not stop Bot tasks")),
      });
    else state.stop.mockRejectedValue(new Error("Could not stop Bot tasks"));
    await using screen = await render(
      <AppSidebarLayout>
        <main>Conversation</main>
      </AppSidebarLayout>,
    );
    const notice = screen.container.querySelector('aside[aria-label="Bot task permission"]')!;
    await showNoticeDetails(notice);
    expect(notice.textContent).toContain("signs you out of Bot in this app");
    expect(notice.textContent).toContain("turns off Experimental Bot here");
    const stop = notice.querySelector("button:not([aria-expanded])") as HTMLButtonElement;
    await act(async () => stop.click());
    expect(notice.querySelector('[role="alert"]')?.textContent).toBe("Could not stop Bot tasks");
    expect(notice.textContent).toContain("cannot currently be checked");
    expect(notice.textContent).not.toContain("Bot tasks are allowed");
    expect(stop.disabled).toBe(false);
    expect(state.stop).toHaveBeenCalledExactlyOnceWith({
      environmentId: "own-harness",
      input: { apiUrl: currentService, ownerToken: ownSession.ownerToken },
    });
    expect(state.local).toBe(unknown);
    expect(state.settings!.tritonAiBotEnabled).toBe(true);
    expect(readDotSession(sessionStorage, currentService)).toEqual(ownSession);
    expect(readDotSession(sessionStorage, earlierService)).toEqual(otherSession);
    expect(state.update).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  },
);
