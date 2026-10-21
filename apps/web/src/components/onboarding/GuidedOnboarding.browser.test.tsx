import { act, render as renderUi, fakeTimers, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  Link: () => null,
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => new Map(),
}));
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
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../../providerInstances", () => ({
  resolveDefaultProviderModelSelection: () => ({ instanceId: "codex", model: "test-model" }),
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: () => ({ settings: { defaultModelSelection: null } }),
}));
vi.mock("../../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: {
      getState: () => ({ stickyActiveProvider: null, stickyModelSelectionByProvider: {} }),
    },
  };
});
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

describe("guided tour", () => {
  it("recommends the sample when no account is connected, and can't pick an unavailable one", async () => {
    await using _fixture = await setupTest();

    await _fixture.openBudgetFileStep();
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
    await using _fixture = await setupTest();

    await _fixture.openBudgetFileStep();
    await _fixture.click("Check a budget for overages");
    await _fixture.click("Check the budget with the sample");

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
    await using _fixture = await setupTest();

    mocks.startTurn.mockResolvedValue({ _tag: "Failure", cause: new Error("offline") });
    await _fixture.openBudgetFileStep();
    await _fixture.click("Check a budget for overages");
    await _fixture.click("Check the budget with the sample");

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
    await using _fixture = await setupTest();

    let finishStart: (value: unknown) => void = () => {};
    mocks.startTurn.mockReturnValue(new Promise((resolve) => (finishStart = resolve)));
    await _fixture.openBudgetFileStep();
    await _fixture.click("Check a budget for overages");
    await _fixture.click("Check the budget with the sample");
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);

    // Exit tour unmounts the route while the chat is still starting.
    await act(async () => _fixture.stack.disposeAsync());
    await act(async () => finishStart({ _tag: "Success", value: { sequence: 1 } }));

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(readGuidedTourState().taskThreadId).toBeNull();
  });

  it("does not start uploading someone's file after they left the tour", async () => {
    await using _fixture = await setupTest();

    let finishCreate: (value: unknown) => void = () => {};
    mocks.projects = [];
    mocks.createProject.mockReturnValue(new Promise((resolve) => (finishCreate = resolve)));
    await _fixture.openBudgetFileStep();
    await _fixture.click("Check a budget for overages");
    const input = document.body.querySelector<HTMLInputElement>("input[type=file]")!;
    const file = new File(["Line,Budget,Actual\nTravel,1,2\n"], "Mine.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(mocks.createProject).toHaveBeenCalledTimes(1);

    await act(async () => _fixture.stack.disposeAsync());
    await act(async () => finishCreate({ _tag: "Success", value: { sequence: 1 } }));

    expect(mocks.startUpload).not.toHaveBeenCalled();
    expect(mocks.startTurn).not.toHaveBeenCalled();
  });

  it("keeps the started task's suggestions even if the selection changes while it starts", async () => {
    await using _fixture = await setupTest();

    let finishStart: (value: unknown) => void = () => {};
    mocks.startTurn.mockReturnValue(new Promise((resolve) => (finishStart = resolve)));
    await _fixture.openBudgetFileStep();
    await _fixture.click("Check a budget for overages");
    await _fixture.click("Check the budget with the sample");

    // Going back and choosing something else while the first chat is still starting.
    await act(async () => updateGuidedTourState({ roleId: "it", taskId: "it-ticket" }));
    await act(async () => finishStart({ _tag: "Success", value: { sequence: 1 } }));

    expect(readGuidedTourState()).toMatchObject({ roleId: "finance", taskId: "finance-budget" });
  });

  it("uses the account that can do the task, and lets you switch accounts", async () => {
    await using _fixture = await setupTest();

    const capability = (id: string, enabled: boolean) => ({
      id,
      displayName: id,
      description: id,
      access: "default",
      enabled,
      granted: enabled,
      available: enabled,
    });
    const account = (id: string, calendarOn: boolean) => ({
      id,
      installed: true,
      enabled: true,
      requiresConnection: true,
      connectionState: "connected",
      accountLabel: null,
      capabilities: [capability("mail.read", true), capability("calendar.read", calendarOn)],
      tools: [],
    });
    mocks.listIntegrations.mockResolvedValue({
      _tag: "Success",
      value: {
        integrations: [account("microsoft-365", false), account("google-workspace", true)],
      },
    });
    await act(async () => _fixture.renderSubject(<GuidedOnboarding />));
    await _fixture.click("Get started");
    await _fixture.click("Office & admin");
    await _fixture.click("Continue");
    await _fixture.click("See what's on my calendar this week");

    expect(document.body.textContent).toContain("You're connected.");
    expect(document.body.textContent).toContain("Gmail & Google");
    expect(document.body.textContent).toContain("Show my week");

    await _fixture.click("Use Outlook instead");
    expect(document.body.textContent).toContain("Turn on reading your calendar.");
    expect(document.body.textContent).toContain("Use Gmail instead");
  });

  it("asks to turn on the calendar instead of claiming it can read it", async () => {
    await using _fixture = await setupTest();

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
    await act(async () => _fixture.renderSubject(<GuidedOnboarding />));
    await _fixture.click("Get started");
    await _fixture.click("Office & admin");
    await _fixture.click("Continue");
    expect(
      [...document.body.querySelectorAll("main button")].find((button) =>
        button.textContent?.includes("Find emails"),
      )?.textContent,
    ).toContain("Recommended");

    await _fixture.click("See what's on my calendar this week");
    expect(document.body.textContent).toContain("Turn on reading your calendar.");
    expect(document.body.textContent).not.toContain("You're connected.");
    expect(document.body.textContent).not.toContain("Show my week");
    expect(document.body.textContent).toContain("Not now. Try it on a file instead");
  });

  it("leaves without changing anything", async () => {
    await using _fixture = await setupTest();

    await act(async () => _fixture.renderSubject(<GuidedOnboarding />));
    await _fixture.click("Exit tour");
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings/general" });
    expect(mocks.startTurn).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});

async function setupTest() {
  const stack = new AsyncDisposableStack();
  let container: HTMLElement;
  let screen: Screen | undefined;

  async function renderSubject(node: import("react").ReactNode) {
    if (screen) await screen.rerender(node);
    else {
      screen = stack.use(
        await renderUi(node, {
          router: false /* These subjects use mocked navigation or no routing. */,
        }),
      );
      container = screen.container;
    }
  }

  async function click(label: string) {
    const target = [...document.body.querySelectorAll("button, label")].find((item) =>
      item.textContent?.includes(label),
    ) as HTMLElement | undefined;
    if (!target) throw new Error(`Nothing labelled "${label}"`);
    await act(async () => target.click());
  }

  /** Welcome → Finance → the budget task, with no email plugin in this copy. */
  async function openBudgetFileStep() {
    await act(async () => renderSubject(<GuidedOnboarding />));
    await click("Get started");
    await click("Finance & purchasing");
    await click("Continue");
    expect(document.body.textContent).toContain("Pick something to try first.");
  }

  screen = undefined;
  vi.clearAllMocks();
  mocks.listIntegrations.mockResolvedValue({ _tag: "Success", value: { integrations: [] } });
  mocks.startTurn.mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
  mocks.projects = [TRITONAI_PROJECT];
  restartGuidedTour();
  return {
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
    stack,
    get container() {
      return container;
    },
    set container(value: typeof container) {
      container = value;
    },
    get screen() {
      return screen;
    },
    set screen(value: typeof screen) {
      screen = value;
    },
    renderSubject,
    click,
    openBudgetFileStep,
  };
}
