// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readGuidedTourState,
  restartGuidedTour,
  updateGuidedTourState,
} from "../../onboarding/guidedTourState";
import { GuidedOnboarding } from "./GuidedOnboarding";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  startTurn: vi.fn(),
  createProject: vi.fn(),
  listIntegrations: vi.fn(),
  unused: vi.fn(),
  startUpload: vi.fn(),
  projects: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  Link: () => null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "createProject" } }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: "startTurn" } }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  environmentServerConfigsAtom: "serverConfigs",
  serverEnvironment: { listIntegrations: "listIntegrations" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "startTurn"
      ? mocks.startTurn
      : command === "createProject"
        ? mocks.createProject
        : command === "listIntegrations"
          ? mocks.listIntegrations
          : mocks.unused,
}));
const TRITONAI_PROJECT = {
  id: "tritonai",
  environmentId: "local",
  workspaceRoot: "/Users/test/TritonAI",
};
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  waitForThreadShell: async () => true,
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../../providerInstances", () => ({
  resolveDefaultProviderModelSelection: () => ({ instanceId: "codex", model: "test-model" }),
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: () => ({ settings: { defaultModelSelection: null } }),
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({ stickyActiveProvider: null, stickyModelSelectionByProvider: {} }),
  },
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: mocks.startUpload,
  awaitAttachmentUploads: async () => {},
  getUploadedAttachments: () => null,
  readAttachmentUpload: () => undefined,
  releaseAttachmentUpload: () => {},
}));
vi.mock("../../firstRunOnboarding", () => ({
  waitForProject: async () => ({
    id: "tritonai",
    environmentId: "local",
    workspaceRoot: "/Users/test/TritonAI",
  }),
}));
vi.mock("../settings/PluginsSettings", () => ({ integrationNeedsConnectionAction: () => false }));

let container: HTMLDivElement;
let root: Root;

async function click(label: string) {
  const target = [...document.body.querySelectorAll("button, label")].find((item) =>
    item.textContent?.includes(label),
  ) as HTMLElement | undefined;
  if (!target) throw new Error(`Nothing labelled "${label}"`);
  await act(async () => target.click());
}

/** Welcome → Finance → the budget task, with no email plugin in this copy. */
async function openBudgetFileStep() {
  await act(async () => root.render(<GuidedOnboarding />));
  await click("Get started");
  await click("Finance & purchasing");
  await click("Continue");
  expect(document.body.textContent).toContain("Pick something to try first.");
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.listIntegrations.mockResolvedValue({ _tag: "Success", value: { integrations: [] } });
  mocks.startTurn.mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
  mocks.projects = [TRITONAI_PROJECT];
  restartGuidedTour();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("guided tour", () => {
  it("recommends the sample when no account is connected, and can't pick an unavailable one", async () => {
    await openBudgetFileStep();
    const [email, budget] = [...document.body.querySelectorAll("main button")].filter((button) =>
      button.textContent?.includes("Uses a file")
        ? true
        : button.textContent?.includes("aren't set up"),
    ) as HTMLButtonElement[];
    expect(email?.disabled).toBe(true);
    expect(budget?.disabled).toBe(false);
    expect(budget?.textContent).toContain("Recommended");
  });

  it("runs the sample in a Supervised conversation, with the sample in the message itself", async () => {
    await openBudgetFileStep();
    await click("Check a budget for overages");
    await click("Check the budget with the sample");

    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    const { input } = mocks.startTurn.mock.calls[0]![0];
    expect(input.runtimeMode).toBe("approval-required");
    expect(input.bootstrap.createThread.runtimeMode).toBe("approval-required");
    expect(input.bootstrap.createThread.projectId).toBe("tritonai");
    expect(input.message.attachments).toEqual([]);
    expect(input.message.text).toContain("Travel,8000,10140");
    expect(mocks.createProject).not.toHaveBeenCalled();

    expect(readGuidedTourState().taskThreadId).toBe(input.threadId);
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: "local", threadId: input.threadId },
      }),
    );
  });

  it("stays on the step with a way to retry when the assistant can't start", async () => {
    mocks.startTurn.mockResolvedValue({ _tag: "Failure", cause: new Error("offline") });
    await openBudgetFileStep();
    await click("Check a budget for overages");
    await click("Check the budget with the sample");

    expect(document.body.querySelector("[role=alert]")?.textContent).toBe(
      "The assistant couldn't start. Try again.",
    );
    expect(readGuidedTourState().taskThreadId).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(
      [...document.body.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("with the sample"),
      )?.disabled,
    ).toBe(false);
  });

  it("does not move someone back into the chat after they left the tour", async () => {
    let finishStart: (value: unknown) => void = () => {};
    mocks.startTurn.mockReturnValue(new Promise((resolve) => (finishStart = resolve)));
    await openBudgetFileStep();
    await click("Check a budget for overages");
    await click("Check the budget with the sample");
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);

    // Exit tour unmounts the route while the chat is still starting.
    await act(async () => root.unmount());
    await act(async () => finishStart({ _tag: "Success", value: { sequence: 1 } }));

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(readGuidedTourState().taskThreadId).toBeNull();
    root = createRoot(container);
  });

  it("does not start uploading someone's file after they left the tour", async () => {
    let finishCreate: (value: unknown) => void = () => {};
    mocks.projects = [];
    mocks.createProject.mockReturnValue(new Promise((resolve) => (finishCreate = resolve)));
    await openBudgetFileStep();
    await click("Check a budget for overages");
    const input = document.body.querySelector<HTMLInputElement>("input[type=file]")!;
    const file = new File(["Line,Budget,Actual\nTravel,1,2\n"], "Mine.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(mocks.createProject).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    await act(async () => finishCreate({ _tag: "Success", value: { sequence: 1 } }));

    expect(mocks.startUpload).not.toHaveBeenCalled();
    expect(mocks.startTurn).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("keeps the started task's suggestions even if the selection changes while it starts", async () => {
    let finishStart: (value: unknown) => void = () => {};
    mocks.startTurn.mockReturnValue(new Promise((resolve) => (finishStart = resolve)));
    await openBudgetFileStep();
    await click("Check a budget for overages");
    await click("Check the budget with the sample");

    // Going back and choosing something else while the first chat is still starting.
    await act(async () => updateGuidedTourState({ roleId: "it", taskId: "it-ticket" }));
    await act(async () => finishStart({ _tag: "Success", value: { sequence: 1 } }));

    expect(readGuidedTourState()).toMatchObject({ roleId: "finance", taskId: "finance-budget" });
  });

  it("asks to turn on the calendar instead of claiming it can read it", async () => {
    const capability = (id: string, enabled: boolean) => ({
      id,
      displayName: id,
      description: id,
      access: "default",
      enabled,
      granted: enabled,
      available: enabled,
    });
    mocks.listIntegrations.mockResolvedValue({
      _tag: "Success",
      value: {
        integrations: [
          {
            id: "microsoft-365",
            installed: true,
            enabled: true,
            requiresConnection: true,
            connectionState: "connected",
            accountLabel: null,
            capabilities: [capability("mail.read", true), capability("calendar.read", false)],
            tools: [],
          },
        ],
      },
    });
    await act(async () => root.render(<GuidedOnboarding />));
    await click("Get started");
    await click("Office & admin");
    await click("Continue");
    expect(
      [...document.body.querySelectorAll("main button")].find((button) =>
        button.textContent?.includes("Find emails"),
      )?.textContent,
    ).toContain("Recommended");

    await click("See what's on my calendar this week");
    expect(document.body.textContent).toContain("Turn on reading your calendar.");
    expect(document.body.textContent).not.toContain("You're connected.");
    expect(document.body.textContent).not.toContain("Show my week");
    expect(document.body.textContent).toContain("Not now. Try it on a file instead");
  });

  it("leaves without changing anything", async () => {
    await act(async () => root.render(<GuidedOnboarding />));
    await click("Exit tour");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings/general" });
    expect(mocks.startTurn).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});
