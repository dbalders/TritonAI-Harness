// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ServerBotTaskComputerStatus } from "@t3tools/contracts";

const configuration = vi.hoisted(() => ({
  serviceUrl: "https://bot.example.test" as string | null,
  local: null as ServerBotTaskComputerStatus | null,
  command: vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("../dot/botService", () => ({ useBotServiceUrl: () => configuration.serviceUrl }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string; hash: string; state: object }) => unknown;
  }) => select({ pathname: "/settings/tritonai-bot", hash: "", state: {} }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "synthetic-environment",
  usePrimaryEnvironment: () => null,
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: configuration.local, refresh: vi.fn() }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => configuration.command }));

import {
  DotApiError,
  DotClient,
  readDotSession,
  saveDotSession,
  type DotState,
} from "../dot/dotClient";
import { BotSettings } from "./BotSettings";

const firstUrl = "https://bot.example.test";
const secondUrl = "https://another.example.test";
const firstSession = {
  ownerToken: "synthetic-first-owner",
  expiresAt: 4_000_000_000,
  email: "first@example.test",
};
const secondSession = {
  ownerToken: "synthetic-second-owner",
  expiresAt: 4_000_000_000,
  email: "second@example.test",
};
const state = (email: string): DotState => ({
  user: { userId: email, email },
  tasks: [],
  runs: [],
  approvals: [],
});
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  configuration.serviceUrl = firstUrl;
  configuration.local = null;
  configuration.command.mockClear();
  sessionStorage.clear();
  saveDotSession(sessionStorage, firstUrl, firstSession);
  saveDotSession(sessionStorage, secondUrl, secondSession);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uses the session for the configured service and ignores an old service's delayed auth failure", async () => {
  let rejectOld!: (cause: unknown) => void;
  const seen: string[] = [];
  vi.spyOn(DotClient.prototype, "state").mockImplementation(async (session) => {
    seen.push(session.ownerToken);
    if (session.ownerToken === firstSession.ownerToken)
      return new Promise<DotState>((_resolve, reject) => {
        rejectOld = reject;
      });
    return state(secondSession.email);
  });
  await act(async () => root.render(<BotSettings />));
  configuration.serviceUrl = secondUrl;
  await act(async () => root.render(<BotSettings />));
  await act(async () => rejectOld(new DotApiError("Old service sign-in expired", 401)));
  expect(seen).toEqual([firstSession.ownerToken, secondSession.ownerToken]);
  expect(readDotSession(sessionStorage, secondUrl)).toEqual(secondSession);
  expect(readDotSession(sessionStorage, firstUrl)).toEqual(firstSession);
  expect(container.textContent).toContain(secondSession.email);
  expect(container.textContent).not.toContain("Old service sign-in expired");
});

it("does not clear a replacement session when a prior account's state request returns 401", async () => {
  let rejectOld!: (cause: unknown) => void;
  vi.spyOn(DotClient.prototype, "state").mockImplementation(async (session) => {
    if (session.ownerToken === firstSession.ownerToken)
      return new Promise<DotState>((_resolve, reject) => {
        rejectOld = reject;
      });
    return state(secondSession.email);
  });
  await act(async () => root.render(<BotSettings />));
  saveDotSession(sessionStorage, firstUrl, secondSession);
  await act(async () => rejectOld(new DotApiError("Old account sign-in expired", 401)));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(readDotSession(sessionStorage, firstUrl)).toEqual(secondSession);
  expect(container.textContent).toContain(secondSession.email);
  expect(container.textContent).not.toContain("Old account sign-in expired");
});

it("explains configuration when the Bot is off without sending any session", async () => {
  configuration.serviceUrl = null;
  const fetchState = vi.spyOn(DotClient.prototype, "state");
  await act(async () => root.render(<BotSettings />));
  expect(container.textContent).toContain("Set a TritonAI Bot service address");
  expect(fetchState).not.toHaveBeenCalled();
});

it.each(["signed out", "different service", "service disabled", "unreachable", "expired session"])(
  "can stop locally when %s without transmitting an unrelated owner token",
  async (scenario) => {
    configuration.local = {
      state: "idle",
      deviceId: "synthetic-device",
      deviceName: "This Mac",
      apiUrl: firstUrl,
      userId: firstSession.email,
      projectId: "synthetic-project",
      currentTask: null,
      lastCheckInAt: null,
      message: null,
    };
    if (scenario === "signed out") saveDotSession(sessionStorage, firstUrl, null);
    if (scenario === "different service") configuration.serviceUrl = secondUrl;
    if (scenario === "service disabled") configuration.serviceUrl = null;
    vi.spyOn(DotClient.prototype, "state").mockImplementation(async () => {
      if (scenario === "expired session") throw new DotApiError("Expired", 401);
      if (scenario === "unreachable") throw new Error("Unavailable");
      return state(secondSession.email);
    });
    await act(async () => root.render(<BotSettings />));
    const stop = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Stop running tasks here",
    );
    expect(stop).toBeDefined();
    expect(stop?.disabled).toBe(false);
    await act(async () => stop?.click());
    expect(configuration.command).toHaveBeenCalledWith({
      environmentId: "synthetic-environment",
      input: { apiUrl: configuration.serviceUrl, ownerToken: null },
    });
  },
);
