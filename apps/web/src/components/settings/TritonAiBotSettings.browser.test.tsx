import { act, render as renderTest, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const config = vi.hoisted(() => ({
  settings: {
    tritonAiBotEnabled: true,
    tritonAiBotUrl: "https://first.example.test" as string | null,
  },
  update: vi.fn(),
  stop: vi.fn<(...args: unknown[]) => Promise<{ _tag: "Success" }>>(async () => ({
    _tag: "Success",
  })),
}));
vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useClientSettings: (select: (settings: typeof config.settings) => unknown) =>
    select(config.settings),
  useClientSettingsHydrated: () => true,
  updateClientSettings: config.update,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => "own-harness",
}));
vi.mock("../../state/server", async (original) => ({
  ...(await original<typeof import("../../state/server")>()),
  serverEnvironment: { stopBotTaskComputer: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => config.stop }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({ title: "Bot service" }) }));

import { TritonAiBotSettings } from "./TritonAiBotSettings";
import { DotClient, readDotSession, saveDotSession } from "../dot/dotClient";
const first = "https://first.example.test";
const session = {
  ownerToken: "synthetic-owner",
  email: "owner@example.test",
  expiresAt: 4_000_000_000,
};
let root: Screen;
let container: HTMLDivElement;
async function setup() {
  config.settings = { tritonAiBotEnabled: true, tritonAiBotUrl: first };
  config.update.mockReset();
  config.update.mockImplementation(async (patch) => Object.assign(config.settings, patch));
  config.stop.mockReset();
  config.stop.mockResolvedValue({ _tag: "Success" });
  sessionStorage.clear();
  saveDotSession(sessionStorage, first, session);
  vi.spyOn(DotClient.prototype, "signOut").mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = await renderTest(<TritonAiBotSettings />, { container, router: false });
  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
      vi.restoreAllMocks();
    },
  };
}
async function edit(value: string) {
  await userEvent.fill(container.querySelector("input")!, value);
}
async function save() {
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Save")!
      .click(),
  );
}

it("stops the old worker before changing services or clearing its session", async () => {
  await using _test = await setup();
  let finish!: (result: { _tag: "Success" }) => void;
  config.stop.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await edit("https://second.example.test");
  await save();
  expect(config.stop).toHaveBeenCalledWith({
    environmentId: "own-harness",
    input: { apiUrl: first, ownerToken: session.ownerToken },
  });
  expect(config.update).not.toHaveBeenCalled();
  expect(readDotSession(sessionStorage, first)).toEqual(session);
  expect(container.querySelector("input")!.disabled).toBe(true);
  await act(async () => finish({ _tag: "Success" }));
  expect(config.settings.tritonAiBotUrl).toBe("https://second.example.test");
  expect(DotClient.prototype.signOut).toHaveBeenCalledWith(session);
  expect(readDotSession(sessionStorage, first)).toBeNull();
});

it("clearing the address stops old claims and restores the managed default", async () => {
  await using _test = await setup();
  await edit("");
  await save();
  expect(config.stop).toHaveBeenCalledWith({
    environmentId: "own-harness",
    input: { apiUrl: first, ownerToken: session.ownerToken },
  });
  expect(config.settings.tritonAiBotUrl).toBeNull();
  expect(readDotSession(sessionStorage, first)).toBeNull();
});

it("preserves the old address and session if its task worker cannot stop", async () => {
  await using _test = await setup();
  config.stop.mockRejectedValue(new Error("Harness is offline"));
  await edit("");
  await save();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Harness is offline");
  expect(config.update).not.toHaveBeenCalled();
  expect(config.settings.tritonAiBotUrl).toBe(first);
  expect(readDotSession(sessionStorage, first)).toEqual(session);
  expect(DotClient.prototype.signOut).not.toHaveBeenCalled();
});

it("keeps an unusable legacy address recoverable with opt-in off", async () => {
  await using _test = await setup();
  config.settings = { tritonAiBotEnabled: false, tritonAiBotUrl: "not-a-service" };
  await act(async () => root.rerender(<TritonAiBotSettings />));
  expect(container.querySelector("input")).not.toBeNull();
  await edit("https://recovered.example.test");
  await save();
  expect(config.stop).toHaveBeenCalledWith({
    environmentId: "own-harness",
    input: { apiUrl: null, ownerToken: null },
  });
  expect(config.settings.tritonAiBotEnabled).toBe(false);
  expect(config.settings.tritonAiBotUrl).toBe("https://recovered.example.test");
});
