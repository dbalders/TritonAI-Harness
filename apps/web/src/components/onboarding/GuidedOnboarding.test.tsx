// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readGuidedTourState, restartGuidedTour } from "../../onboarding/guidedTourState";
import { GuidedOnboarding } from "./GuidedOnboarding";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  startTurn: vi.fn(),
  createProject: vi.fn(),
  listIntegrations: vi.fn(),
  unused: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
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
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "tritonai", environmentId: "local", workspaceRoot: "/Users/test/TritonAI" },
  ],
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
vi.mock("../../lib/attachmentUploadQueue", () => ({}));
vi.mock("../../firstRunOnboarding", () => ({ waitForProject: async () => null }));
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

  it("leaves without changing anything", async () => {
    await act(async () => root.render(<GuidedOnboarding />));
    await click("Exit tour");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings/general" });
    expect(mocks.startTurn).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});
