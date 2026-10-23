import { act, render as renderTest, type Screen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import type { ServerBotTaskComputerStatus } from "@t3tools/contracts";
import { Cause } from "effect";

const configuration = vi.hoisted(() => ({
  serviceUrl: "https://bot.example.test" as string | null,
  canControlTasks: true,
  local: null as ServerBotTaskComputerStatus | null,
  localListeners: new Set<() => void>(),
  projects: [] as Array<{
    id: string;
    title: string;
    environmentId: string;
    workspaceRoot?: string;
  }>,
  scratchRoot: null as string | null,
  openScratchProject: vi.fn<(environmentId: string) => Promise<{ id: string } | null>>(),
  command: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ _tag: "Success" })),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => configuration.canControlTasks,
}));
vi.mock("../dot/botService", () => ({ useBotServiceUrl: () => configuration.serviceUrl }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useLocation: ({
    select,
  }: {
    select: (location: { pathname: string; hash: string; state: object }) => unknown;
  }) => select({ pathname: "/settings/tritonai-bot", hash: "", state: {} }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => configuration.projects }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "synthetic-environment",
  usePrimaryEnvironment: () => null,
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentQuery: () => ({
      data: useSyncExternalStore(
        (listener) => {
          configuration.localListeners.add(listener);
          return () => {
            configuration.localListeners.delete(listener);
          };
        },
        () => configuration.local,
      ),
      refresh: vi.fn(),
    }),
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => configuration.command }));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchWorkspaceRootFor: () => configuration.scratchRoot,
    openScratchProject: configuration.openScratchProject,
  }),
}));

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
let root: Screen;
let container: HTMLDivElement;

async function setupTest() {
  configuration.canControlTasks = true;
  vi.useFakeTimers();
  configuration.serviceUrl = firstUrl;
  configuration.local = null;
  configuration.projects = [];
  configuration.scratchRoot = null;
  configuration.openScratchProject.mockReset();
  configuration.command.mockReset();
  configuration.command.mockResolvedValue({ _tag: "Success" });
  sessionStorage.clear();
  saveDotSession(sessionStorage, firstUrl, firstSession);
  saveDotSession(sessionStorage, secondUrl, secondSession);
  container = document.createElement("div");
  document.body.append(container);
  root = await renderTest(null, { container, router: false });

  return {
    async [Symbol.asyncDispose]() {
      await act(async () => root.unmount());
      container.remove();
      sessionStorage.clear();
      vi.restoreAllMocks();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

it("uses the session for the configured service and ignores an old service's delayed auth failure", async () => {
  await using _test = await setupTest();
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
  await act(async () => root.rerender(<BotSettings />));
  configuration.serviceUrl = secondUrl;
  await act(async () => root.rerender(<BotSettings />));
  await act(async () => rejectOld(new DotApiError("Old service sign-in expired", 401)));
  expect(seen).toEqual([firstSession.ownerToken, secondSession.ownerToken]);
  expect(readDotSession(sessionStorage, secondUrl)).toEqual(secondSession);
  expect(readDotSession(sessionStorage, firstUrl)).toEqual(firstSession);
  expect(container.textContent).toContain(secondSession.email);
  expect(container.textContent).not.toContain("Old service sign-in expired");
});

it("does not clear a replacement session when a prior account's state request returns 401", async () => {
  await using _test = await setupTest();
  let rejectOld!: (cause: unknown) => void;
  vi.spyOn(DotClient.prototype, "state").mockImplementation(async (session) => {
    if (session.ownerToken === firstSession.ownerToken)
      return new Promise<DotState>((_resolve, reject) => {
        rejectOld = reject;
      });
    return state(secondSession.email);
  });
  await act(async () => root.rerender(<BotSettings />));
  saveDotSession(sessionStorage, firstUrl, secondSession);
  await act(async () => rejectOld(new DotApiError("Old account sign-in expired", 401)));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(readDotSession(sessionStorage, firstUrl)).toEqual(secondSession);
  expect(container.textContent).toContain(secondSession.email);
  expect(container.textContent).not.toContain("Old account sign-in expired");
});

it("explains configuration when the Bot is off without sending any session", async () => {
  await using _test = await setupTest();
  configuration.serviceUrl = null;
  const fetchState = vi.spyOn(DotClient.prototype, "state");
  await act(async () => root.rerender(<BotSettings />));
  expect(container.textContent).toContain("Enable TritonAI Bot in Settings");
  expect(fetchState).not.toHaveBeenCalled();
});

it("shows saved result delivery instead of claiming a finished task is still running", async () => {
  await using _test = await setupTest();
  configuration.local = {
    state: "idle",
    deviceId: "synthetic-device",
    deviceName: "This Mac",
    apiUrl: firstUrl,
    userId: firstSession.email,
    projectId: "synthetic-project",
    currentTask: null,
    lastCheckInAt: "2026-10-12T20:00:00Z",
    message:
      "Finished running “Report”. Its saved result and files are awaiting delivery to your bot. Retrying automatically.",
  };
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  await act(async () => root.rerender(<BotSettings />));
  expect(container.textContent).toContain("Finished running “Report”");
  expect(container.textContent).toContain("saved result and files are awaiting delivery");
  expect(container.textContent).not.toContain("Running “Report” in a Harness thread");
  expect(container.textContent).not.toContain("Waiting for approved tasks");
});

it("keeps a rejected result notice visible while another Harness task is running", async () => {
  await using _test = await setupTest();
  configuration.local = {
    state: "running",
    deviceId: "synthetic-device",
    deviceName: "This Mac",
    apiUrl: firstUrl,
    userId: firstSession.email,
    projectId: "synthetic-project",
    currentTask: { taskId: "next", title: "Next report", threadId: "next-thread", startedAt: "" },
    lastCheckInAt: null,
    message:
      "Your bot could not accept the result for “Earlier report”. The full result and evidence remain saved on this computer. Open “Earlier report” in Harness to review it. Other assignments can continue.",
  };
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  await act(async () => root.rerender(<BotSettings />));
  expect(container.textContent).toContain("Running “Next report” in a Harness thread");
  expect(container.textContent).toContain("could not accept the result for “Earlier report”");
  expect(container.textContent).toContain("full result and evidence remain saved");
});

it.each(["loading", "signed out", "expired session", "unreachable"])(
  "preserves the local running task and result recovery notice when Bot state is %s",
  async (scenario) => {
    await using _test = await setupTest();
    configuration.local = {
      state: "running",
      deviceId: "synthetic-device",
      deviceName: "This Mac",
      apiUrl: firstUrl,
      userId: firstSession.email,
      projectId: "synthetic-project",
      currentTask: { taskId: "next", title: "Next report", threadId: "next-thread", startedAt: "" },
      lastCheckInAt: null,
      message:
        "Your bot could not accept the result for “Earlier report”. The full result and evidence remain saved on this computer. Open “Earlier report” in Harness to review it.",
    };
    const fetchState = vi.spyOn(DotClient.prototype, "state");
    if (scenario === "loading")
      fetchState.mockImplementation(() => new Promise<DotState>(() => {}));
    else if (scenario === "unreachable") fetchState.mockRejectedValue(new Error("Unavailable"));
    else fetchState.mockResolvedValue(state(firstSession.email));
    if (scenario === "signed out") saveDotSession(sessionStorage, firstUrl, null);
    await act(async () => root.rerender(<BotSettings />));
    if (scenario === "expired session") {
      fetchState.mockRejectedValue(new DotApiError("Expired", 401));
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(readDotSession(sessionStorage, firstUrl)).toBeNull();
    }
    if (scenario === "signed out") expect(fetchState).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Running “Next report” in a Harness thread");
    expect(container.textContent).toContain("could not accept the result for “Earlier report”");
    expect(container.textContent).toContain("full result and evidence remain saved");
    expect(container.textContent).not.toContain("paired with a different Bot service or account");
    const stop = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Stop running tasks here",
    )!;
    await act(async () => stop.click());
    expect(configuration.command).toHaveBeenCalledWith({
      environmentId: "synthetic-environment",
      input: { apiUrl: firstUrl, ownerToken: null },
    });
  },
);

it.each(["signed out", "different service", "service disabled", "unreachable", "expired session"])(
  "can stop locally when %s without transmitting an unrelated owner token",
  async (scenario) => {
    await using _test = await setupTest();
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
    await act(async () => root.rerender(<BotSettings />));
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

function projectPicker(): HTMLButtonElement {
  return container.querySelector('[aria-label="Project for tasks"]')!;
}

it("recovers the controls and reports a rejected Stop request so the owner can retry", async () => {
  await using _test = await setupTest();
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
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  let rejectStop!: (cause: unknown) => void;
  configuration.command.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectStop = reject;
      }),
  );
  await act(async () => root.rerender(<BotSettings />));
  const stop = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Stop running tasks here",
  )!;
  await act(async () => stop.click());
  expect(stop.disabled).toBe(true);
  await act(async () => rejectStop(new Error("Could not reach this computer")));
  expect(stop.disabled).toBe(false);
  expect(container.textContent).toContain("Could not reach this computer");
  await act(async () => stop.click());
  expect(configuration.command).toHaveBeenCalledTimes(2);
  expect(configuration.command).toHaveBeenLastCalledWith({
    environmentId: "synthetic-environment",
    input: { apiUrl: firstUrl, ownerToken: firstSession.ownerToken },
  });
  expect(container.textContent).not.toContain("Could not reach this computer");
});

async function publishLocal(local: ServerBotTaskComputerStatus | null) {
  await act(async () => {
    configuration.local = local;
    for (const listener of configuration.localListeners) listener();
  });
}

async function chooseProject(title: string) {
  await act(async () => projectPicker().click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (item) => item.textContent === title,
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
}

function setProjectSettings(localState: ServerBotTaskComputerStatus["state"] = "idle") {
  configuration.projects = ["Saved", "Chosen", "External"].map((title) => ({
    id: title.toLowerCase(),
    title,
    environmentId: "synthetic-environment",
  }));
  configuration.local = {
    state: localState,
    deviceId: "local-device",
    deviceName: "This Mac",
    apiUrl: firstUrl,
    userId: firstSession.email,
    projectId: "saved",
    currentTask: null,
    lastCheckInAt: null,
    message: null,
  };
}

it.each(["local first", "bot first"])(
  "waits for pairing identity before saving an active computer project when %s loads",
  async (order) => {
    await using _test = await setupTest();
    setProjectSettings();
    const activeLocal = configuration.local;
    let resolveState!: (value: DotState) => void;
    if (order === "local first") {
      vi.spyOn(DotClient.prototype, "state").mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveState = resolve;
          }),
      );
    } else {
      configuration.local = null;
      vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
    }
    await act(async () => root.rerender(<BotSettings />));
    expect(projectPicker().disabled).toBe(true);
    await act(async () => projectPicker().click());
    expect(configuration.command).not.toHaveBeenCalled();
    if (order === "local first") await act(async () => resolveState(state(firstSession.email)));
    else {
      await publishLocal(activeLocal);
    }
    expect(projectPicker().textContent).toContain("Saved");
    expect(projectPicker().disabled).toBe(false);
    await chooseProject("Chosen");
    expect(configuration.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: "synthetic-environment",
      input: { projectId: "chosen" },
    });
    await publishLocal({ ...configuration.local!, projectId: "chosen" });
    expect(projectPicker().textContent).toContain("Chosen");
  },
);

it.each(["off", "replaced"] as const)(
  "retains a pre-Allow project choice for an %s computer while Bot state loads",
  async (localState) => {
    await using _test = await setupTest();
    setProjectSettings(localState);
    let resolveState!: (value: DotState) => void;
    vi.spyOn(DotClient.prototype, "state")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveState = resolve;
          }),
      )
      .mockResolvedValue(state(firstSession.email));
    await act(async () => root.rerender(<BotSettings />));
    expect(projectPicker().disabled).toBe(false);
    await chooseProject("Chosen");
    expect(configuration.command).not.toHaveBeenCalled();
    expect(projectPicker().textContent).toContain("Chosen");
    await act(async () => resolveState(state(firstSession.email)));
    const allow = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Allow",
    )!;
    await act(async () => allow.click());
    expect(configuration.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: "synthetic-environment",
      input: { apiUrl: firstUrl, ownerToken: firstSession.ownerToken, projectId: "chosen" },
    });
    await publishLocal({ ...configuration.local!, state: "idle", projectId: "chosen" });
    await publishLocal({ ...configuration.local!, projectId: "external" });
    expect(projectPicker().textContent).toContain("External");
  },
);

it("follows authoritative local project status after a save and shows later local changes", async () => {
  await using _test = await setupTest();
  setProjectSettings();
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  await act(async () => root.rerender(<BotSettings />));
  await chooseProject("Chosen");
  await publishLocal({ ...configuration.local!, projectId: "chosen" });
  expect(projectPicker().textContent).toContain("Chosen");
  await publishLocal({ ...configuration.local!, projectId: "external" });
  expect(projectPicker().textContent).toContain("External");
});

it("shows another window's project when the first refresh after a successful save skips that saved project", async () => {
  await using _test = await setupTest();
  setProjectSettings();
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  configuration.command.mockResolvedValueOnce({
    _tag: "Success",
    value: { ...configuration.local!, projectId: "chosen" },
  });
  await act(async () => root.rerender(<BotSettings />));
  await chooseProject("Chosen");
  await publishLocal({ ...configuration.local!, projectId: "external" });
  expect(projectPicker().textContent).toContain("External");
  expect(projectPicker().textContent).not.toContain("Chosen");
  expect(configuration.command).toHaveBeenCalledExactlyOnceWith({
    environmentId: "synthetic-environment",
    input: { projectId: "chosen" },
  });
});

it.each(["different service", "different account"])(
  "keeps a new project as an Allow choice instead of modifying a pairing for a %s",
  async (scenario) => {
    await using _test = await setupTest();
    setProjectSettings();
    configuration.local = {
      ...configuration.local!,
      apiUrl: scenario === "different service" ? secondUrl : firstUrl,
      userId: scenario === "different account" ? secondSession.email : firstSession.email,
    };
    vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
    await act(async () => root.rerender(<BotSettings />));
    await chooseProject("Chosen");
    expect(configuration.command).not.toHaveBeenCalled();
    const allow = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Allow",
    )!;
    await act(async () => allow.click());
    expect(configuration.command).toHaveBeenCalledExactlyOnceWith({
      environmentId: "synthetic-environment",
      input: { apiUrl: firstUrl, ownerToken: firstSession.ownerToken, projectId: "chosen" },
    });
  },
);

it("ignores an old account's project save after a replacement session becomes authoritative", async () => {
  await using _test = await setupTest();
  setProjectSettings();
  vi.spyOn(DotClient.prototype, "state").mockImplementation(async (session) =>
    state(session.email),
  );
  let settle!: (value: unknown) => void;
  configuration.command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await act(async () => root.rerender(<BotSettings />));
  await chooseProject("Chosen");
  saveDotSession(sessionStorage, firstUrl, secondSession);
  configuration.local = {
    ...configuration.local!,
    userId: secondSession.email,
    projectId: "external",
  };
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  await act(async () => settle({ _tag: "Success" }));
  expect(projectPicker().textContent).toContain("External");
  expect(container.textContent).toContain(secondSession.email);
  expect(configuration.command).toHaveBeenCalledTimes(1);
});

it("does not change an active project through a stale session before the next state refresh", async () => {
  await using _test = await setupTest();
  setProjectSettings();
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  await act(async () => root.rerender(<BotSettings />));
  saveDotSession(sessionStorage, firstUrl, secondSession);
  await chooseProject("Chosen");
  expect(configuration.command).not.toHaveBeenCalled();
  expect(projectPicker().textContent).toContain("Saved");
});

it("ignores a prior service's pending project save after the settings service changes", async () => {
  await using _test = await setupTest();
  setProjectSettings();
  vi.spyOn(DotClient.prototype, "state").mockImplementation(async (session) =>
    state(session.email),
  );
  let settle!: (value: unknown) => void;
  configuration.command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await act(async () => root.rerender(<BotSettings />));
  await chooseProject("Chosen");
  configuration.serviceUrl = secondUrl;
  configuration.local = {
    ...configuration.local!,
    apiUrl: secondUrl,
    userId: secondSession.email,
    projectId: "external",
  };
  await act(async () => root.rerender(<BotSettings />));
  await act(async () => settle({ _tag: "Success" }));
  expect(projectPicker().textContent).toContain("External");
  expect(container.textContent).toContain(secondSession.email);
  expect(configuration.command).toHaveBeenCalledTimes(1);
});

it("retains the saved project after a failed change and accepts a later successful selection", async () => {
  await using _test = await setupTest();
  configuration.projects = ["Saved", "Rejected", "Accepted"].map((title) => ({
    id: title.toLowerCase(),
    title,
    environmentId: "synthetic-environment",
  }));
  configuration.local = {
    state: "idle",
    deviceId: "local-device",
    deviceName: "This Mac",
    apiUrl: firstUrl,
    userId: firstSession.email,
    projectId: "saved",
    currentTask: null,
    lastCheckInAt: null,
    message: null,
  };
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  let settle!: (result: unknown) => void;
  configuration.command.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  await act(async () => root.rerender(<BotSettings />));
  await chooseProject("Rejected");
  expect(configuration.command).toHaveBeenCalledExactlyOnceWith({
    environmentId: "synthetic-environment",
    input: { projectId: "rejected" },
  });
  expect(projectPicker().textContent).toContain("Saved");
  expect(projectPicker().disabled).toBe(true);
  await act(async () => projectPicker().click());
  expect(configuration.command).toHaveBeenCalledTimes(1);
  await act(async () =>
    settle({ _tag: "Failure", cause: Cause.fail(new Error("Project save failed")) }),
  );
  expect(projectPicker().textContent).toContain("Saved");
  expect(projectPicker().disabled).toBe(false);
  expect(container.textContent).toContain("Project save failed");
  await chooseProject("Accepted");
  await publishLocal({ ...configuration.local!, projectId: "accepted" });
  expect(projectPicker().textContent).toContain("Accepted");
  expect(container.textContent).not.toContain("Project save failed");
});

it.each(["different service", "different account"])(
  "discloses an existing pairing for a %s before describing another task computer",
  async (scenario) => {
    await using _test = await setupTest();
    configuration.local = {
      state: "idle",
      deviceId: "local-device",
      deviceName: "This Mac",
      apiUrl: scenario === "different service" ? secondUrl : firstUrl,
      userId: scenario === "different account" ? secondSession.email : firstSession.email,
      projectId: "saved",
      currentTask: null,
      lastCheckInAt: null,
      message: null,
    };
    vi.spyOn(DotClient.prototype, "state").mockResolvedValue({
      ...state(firstSession.email),
      taskComputer: {
        deviceId: "remote-device",
        deviceName: "Other Mac",
        pairedAt: "2026-10-12T12:00:00Z",
        online: true,
      },
    });
    await act(async () => root.rerender(<BotSettings />));
    expect(container.textContent).toContain(
      "This Harness is paired with a different Bot service or account",
    );
    expect(container.textContent).not.toContain("Checking this computer");
    expect(container.textContent).not.toContain("Allow moves task running here");
    expect(container.textContent).toContain("Other Mac is online");
  },
);

function allowButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Allow",
  );
}

it("defaults a new task computer to No project and creates it on Allow", async () => {
  await using _test = await setupTest();
  configuration.scratchRoot = "/synthetic/scratch";
  configuration.openScratchProject.mockResolvedValue({ id: "scratch" });
  configuration.local = {
    state: "off",
    deviceId: "local-device",
    deviceName: "This Mac",
    apiUrl: null,
    userId: null,
    projectId: null,
    currentTask: null,
    lastCheckInAt: null,
    message: null,
  };
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  await act(async () => root.rerender(<BotSettings />));
  expect(projectPicker().textContent).toContain("No project");
  expect(container.textContent).toContain("Each task gets its own new folder");
  expect(allowButton()!.disabled).toBe(false);
  await act(async () => allowButton()!.click());
  expect(configuration.openScratchProject).toHaveBeenCalledExactlyOnceWith("synthetic-environment");
  expect(configuration.command).toHaveBeenCalledExactlyOnceWith({
    environmentId: "synthetic-environment",
    input: { apiUrl: firstUrl, ownerToken: firstSession.ownerToken, projectId: "scratch" },
  });
});

it("does not pair when No project cannot be created", async () => {
  await using _test = await setupTest();
  configuration.scratchRoot = "/synthetic/scratch";
  configuration.openScratchProject.mockResolvedValue(null);
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  await act(async () => root.rerender(<BotSettings />));
  await act(async () => allowButton()!.click());
  expect(configuration.openScratchProject).toHaveBeenCalledOnce();
  expect(configuration.command).not.toHaveBeenCalled();
  expect(allowButton()!.disabled).toBe(false);
});

it("shows a saved Scratch project once, as No project", async () => {
  await using _test = await setupTest();
  setProjectSettings();
  configuration.scratchRoot = "/synthetic/scratch";
  configuration.projects.push({
    id: "scratch",
    title: "No project",
    environmentId: "synthetic-environment",
    workspaceRoot: "/synthetic/scratch",
  });
  configuration.local = { ...configuration.local!, projectId: "scratch" };
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  await act(async () => root.rerender(<BotSettings />));
  expect(projectPicker().textContent).toContain("No project");
  await act(async () => projectPicker().click());
  const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map(
    (item) => item.textContent,
  );
  expect(options).toEqual(["No project", "Saved", "Chosen", "External"]);
});

it.each([
  ["another account signs in", secondSession, false],
  ["the owner signs out", null, false],
  ["the session is unchanged", firstSession, true],
] as const)(
  "pairs with No project only if the session is still current when %s while it is created",
  async (_scenario, sessionAfter, pairs) => {
    await using _test = await setupTest();
    configuration.scratchRoot = "/synthetic/scratch";
    let resolveScratch!: (project: { id: string } | null) => void;
    configuration.openScratchProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScratch = resolve;
        }),
    );
    vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
    await act(async () => root.rerender(<BotSettings />));
    await act(async () => allowButton()!.click());
    expect(configuration.openScratchProject).toHaveBeenCalledOnce();
    expect(allowButton()!.disabled).toBe(true);

    saveDotSession(sessionStorage, firstUrl, sessionAfter);
    await act(async () => resolveScratch({ id: "scratch" }));

    if (pairs) {
      expect(configuration.command).toHaveBeenCalledExactlyOnceWith({
        environmentId: "synthetic-environment",
        input: { apiUrl: firstUrl, ownerToken: firstSession.ownerToken, projectId: "scratch" },
      });
    } else {
      expect(configuration.command).not.toHaveBeenCalled();
    }
    expect(allowButton()!.disabled).toBe(false);
  },
);

it("disables task-computer controls when the paired client lacks task permission", async () => {
  await using _test = await setupTest();
  setProjectSettings("off");
  configuration.canControlTasks = false;
  vi.spyOn(DotClient.prototype, "state").mockResolvedValue(state(firstSession.email));
  await act(async () => root.rerender(<BotSettings />));
  expect(allowButton()!.disabled).toBe(true);
  expect(projectPicker().disabled).toBe(true);
  await act(async () => allowButton()!.click());
  expect(configuration.command).not.toHaveBeenCalled();
});
