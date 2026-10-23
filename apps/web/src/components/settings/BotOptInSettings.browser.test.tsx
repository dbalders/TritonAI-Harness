import { act, render as renderTest, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import type { ServerBotTaskComputerStatus } from "@t3tools/contracts";

const config = vi.hoisted(() => ({
  settings: { tritonAiBotEnabled: false, tritonAiBotUrl: null as string | null },
  update: vi.fn(),
  stop: vi.fn(async () => ({ _tag: "Success" })),
  serviceUrl: "https://bot.example.test" as string | null,
  local: null as ServerBotTaskComputerStatus | null,
  refresh: vi.fn(),
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useClientSettings: (select: (settings: typeof config.settings) => unknown) =>
    select(config.settings),
  useClientSettingsHydrated: () => true,
  updateClientSettings: config.update,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "own-harness",
}));
vi.mock("../../state/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/server")>()),
  serverEnvironment: { stopBotTaskComputer: {}, botTaskComputer: vi.fn() },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: config.local, refresh: config.refresh }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => config.stop }));
vi.mock("./settingsSearch", () => ({
  searchableSetting: () => ({ title: "TritonAI Bot (experimental)" }),
}));
vi.mock("../dot/botService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../dot/botService")>();
  return {
    ...original,
    resolveBotServiceUrl: (setting: string | null) =>
      original.resolveBotServiceUrl(setting, config.serviceUrl),
  };
});

import { BotOptInSettings } from "./BotOptInSettings";
import { DotClient, readDotSession, saveDotSession } from "../dot/dotClient";

let root: Screen;
let container: HTMLDivElement;
async function setupTest() {
  config.settings = { tritonAiBotEnabled: false, tritonAiBotUrl: null };
  config.serviceUrl = "https://bot.example.test";
  config.local = null;
  config.refresh.mockReset();
  config.update.mockReset();
  config.update.mockImplementation(async (patch) => Object.assign(config.settings, patch));
  config.stop.mockReset();
  config.stop.mockResolvedValue({ _tag: "Success" });
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = await renderTest(null, { container, router: false });

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

async function render() {
  await act(async () => root.rerender(<BotOptInSettings />));
}
async function toggle() {
  await act(async () => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
}

it("starts off and enabling never signs in, connects Microsoft or pairs a worker", async () => {
  await using _test = await setupTest();
  const fetch = vi.spyOn(globalThis, "fetch");
  await render();
  expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  await toggle();
  expect(config.settings.tritonAiBotEnabled).toBe(true);
  expect(config.stop).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Open Bot");
});

it("stops claims before signing out and hiding Bot, retaining no local session", async () => {
  await using _test = await setupTest();
  config.settings.tritonAiBotEnabled = true;
  const session = {
    ownerToken: "synthetic-owner",
    email: "own@example.test",
    expiresAt: 4_000_000_000,
  };
  saveDotSession(sessionStorage, config.serviceUrl!, session);
  const signOut = vi.spyOn(DotClient.prototype, "signOut").mockImplementation(async () => {
    expect(config.stop).toHaveBeenCalled();
    expect(config.settings.tritonAiBotEnabled).toBe(true);
    return { ok: true };
  });
  await render();
  await toggle();
  expect(signOut).toHaveBeenCalledWith(session);
  expect(config.settings.tritonAiBotEnabled).toBe(false);
  expect(readDotSession(sessionStorage, config.serviceUrl!)).toBeNull();
});

it("keeps the session and opt-in visible when stopping tasks fails", async () => {
  await using _test = await setupTest();
  config.settings.tritonAiBotEnabled = true;
  saveDotSession(sessionStorage, config.serviceUrl!, {
    ownerToken: "synthetic-owner",
    email: "own@example.test",
    expiresAt: 4_000_000_000,
  });
  config.stop.mockRejectedValue(new Error("Harness is offline"));
  await render();
  await toggle();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Harness is offline");
  expect(config.settings.tritonAiBotEnabled).toBe(true);
  expect(readDotSession(sessionStorage, config.serviceUrl!)).not.toBeNull();
});

it.each(["idle", "running", "error"] as const)(
  "exposes a prior Nightly pairing (%s) while opt-in stays off, without granting or stopping on upgrade",
  async (state) => {
    await using _test = await setupTest();
    const earlierService = "https://earlier.example.test";
    config.local = { state, apiUrl: earlierService } as ServerBotTaskComputerStatus;
    const fetch = vi.spyOn(globalThis, "fetch");
    await render();
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "earlier pairing is still active",
    );
    expect(config.stop).not.toHaveBeenCalled();
    expect(config.update).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Stop Bot tasks here")!
        .click(),
    );
    expect(config.stop).toHaveBeenCalledWith({
      environmentId: "own-harness",
      input: { apiUrl: earlierService, ownerToken: null },
    });
    expect(config.settings.tritonAiBotEnabled).toBe(false);
    expect(config.refresh).toHaveBeenCalledOnce();
    config.local = { state: "off", apiUrl: null } as ServerBotTaskComputerStatus;
    await render();
    expect(container.textContent).not.toContain("Stop Bot tasks here");
  },
);

it("keeps a failed prior-pairing stop visible and never forwards another service's session", async () => {
  await using _test = await setupTest();
  config.local = {
    state: "running",
    apiUrl: "https://earlier.example.test",
  } as ServerBotTaskComputerStatus;
  saveDotSession(sessionStorage, config.serviceUrl!, {
    ownerToken: "synthetic-current-service-owner",
    email: "own@example.test",
    expiresAt: 4_000_000_000,
  });
  config.stop.mockRejectedValue(new Error("Harness is offline"));
  await render();
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Stop Bot tasks here")!
      .click(),
  );
  expect(config.stop).toHaveBeenCalledWith({
    environmentId: "own-harness",
    input: { apiUrl: "https://earlier.example.test", ownerToken: null },
  });
  expect(config.settings.tritonAiBotEnabled).toBe(false);
  expect(container.textContent).toContain("earlier pairing is still active");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Harness is offline");
  expect(readDotSession(sessionStorage, config.serviceUrl!)).not.toBeNull();
});

it("recovers an empty legacy address with the managed default while enabling grants nothing", async () => {
  await using _test = await setupTest();
  config.settings.tritonAiBotUrl = "";
  const fetch = vi.spyOn(globalThis, "fetch");
  await render();
  expect(container.querySelector('[role="switch"]')?.hasAttribute("data-disabled")).toBe(false);
  await toggle();
  expect(config.settings).toEqual({ tritonAiBotEnabled: true, tritonAiBotUrl: null });
  expect(container.textContent).toContain("Open Bot");
  expect(config.stop).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("also exposes the earlier pairing when the configured service is unavailable", async () => {
  await using _test = await setupTest();
  config.settings = { tritonAiBotEnabled: true, tritonAiBotUrl: "invalid-old-address" };
  config.local = {
    state: "idle",
    apiUrl: "https://earlier.example.test",
  } as ServerBotTaskComputerStatus;
  await render();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Experimental Bot is unavailable",
  );
  expect(container.textContent).toContain("Stop Bot tasks here");
  expect(config.stop).not.toHaveBeenCalled();
});
