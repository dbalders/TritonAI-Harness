import { act, render as renderTest, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const config = vi.hoisted(() => ({
  settings: { tritonAiBotEnabled: false, tritonAiBotUrl: null as string | null },
  update: vi.fn(),
  stop: vi.fn(async () => ({ _tag: "Success" })),
  serviceUrl: "https://bot.example.test" as string | null,
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
  serverEnvironment: { stopBotTaskComputer: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => config.stop }));
vi.mock("./settingsSearch", () => ({
  searchableSetting: () => ({ title: "TritonAI Bot (experimental)" }),
}));
vi.mock("../dot/botService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dot/botService")>()),
  resolveBotServiceUrl: () => config.serviceUrl,
}));

import { BotOptInSettings } from "./BotOptInSettings";
import { DotClient, readDotSession, saveDotSession } from "../dot/dotClient";

let root: Screen;
let container: HTMLDivElement;
async function setupTest() {
  config.settings = { tritonAiBotEnabled: false, tritonAiBotUrl: null };
  config.serviceUrl = "https://bot.example.test";
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
