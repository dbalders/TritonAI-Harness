import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ClientSettings,
  type GettingStartedChapterId,
  type Idea,
} from "@t3tools/contracts";
import { act, createElement, useLayoutEffect, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useOpenIdeaDraft } from "../components/ideas/useOpenIdeaDraft";
import { GettingStartedHost } from "../components/onboarding/GettingStartedHost";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  persistClientSettingsUpdate,
} from "../hooks/useSettings";
import { reduceGettingStarted } from "./gettingStarted.logic";
import { recordGettingStartedSubmission, updateGettingStarted } from "./gettingStartedState";
import { useGettingStartedActions } from "./useGettingStartedActions";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  openProject: vi.fn<() => Promise<{ id: ProjectId; environmentId: EnvironmentId } | null>>(),
  newThread: vi.fn<
    (
      project: unknown,
      options?: { newDraftPrompt?: string },
    ) => Promise<{
      draftId: DraftId;
      threadId: ThreadId;
    } | null>
  >(),
  navigate: vi.fn(async () => {}),
  router: { state: { location: { href: "/getting-started" } } },
  configs: new Map(),
}));

vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence: mocks }) }));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => mocks.configs,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => mocks.router,
  useNavigate: () => mocks.navigate,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/ideas" }),
}));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => mocks.newThread }));
vi.mock("./useTritonAiProject", () => ({ useTritonAiProject: () => mocks.openProject }));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: (environmentId: EnvironmentId) => environmentId,
    openScratchProject: mocks.openProject,
  }),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [],
}));
vi.mock("../providerInstances", async (original) => ({
  ...(await original<typeof import("../providerInstances")>()),
  resolveDefaultProviderModelSelection: () => ({ providerInstanceId: "codex", model: "test" }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () => ENVIRONMENT,
}));
vi.mock("../components/onboarding/useIntegrationConnection", () => ({
  useIntegrationConnection: () => ({ status: "unavailable", integration: null }),
}));
vi.mock("../components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => createElement("button", props),
}));
vi.mock("../components/onboarding/GettingStartedPanel", () => ({
  GettingStartedPanel: (props: {
    children: ReactNode;
    onSelectChapter: (chapter: string) => void;
    onRestart: () => void;
  }) =>
    createElement(
      "section",
      null,
      props.children,
      createElement("button", { onClick: () => props.onSelectChapter("files") }, "Select Files"),
      createElement("button", { onClick: props.onRestart }, "Restart"),
    ),
}));

const ENVIRONMENT = EnvironmentId.make("guide-races");
const THREAD = ThreadId.make("guide-draft-thread");
const DRAFT = DraftId.make("guide-draft");
const PROJECT = { environmentId: ENVIRONMENT, id: ProjectId.make("tritonai-practice") };
const AT = "2026-10-22T10:00:00.000Z";
const IDEA: Idea = {
  id: "guide-idea",
  section: "starter",
  icon: "💡",
  title: "Make a plan",
  body: "Review a useful draft.",
  sources: [],
  action: { kind: "new-thread", projectId: null, prompt: "Original idea" },
  createdAt: AT,
  openedAt: null,
  draftThreadIds: [],
  snoozedUntil: null,
};

let renderer: ReactTestRenderer | undefined;
let durable: ClientSettings;

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function select(chapter: GettingStartedChapterId) {
  const started = reduceGettingStarted(DEFAULT_CLIENT_SETTINGS.gettingStarted, {
    type: "start",
    environmentId: ENVIRONMENT,
    at: AT,
  });
  durable = {
    ...DEFAULT_CLIENT_SETTINGS,
    gettingStarted: reduceGettingStarted(started, { type: "select", chapter }),
  };
  __setClientSettingsForTests(durable);
}

function holdNextSave() {
  const entered = deferred<void>();
  const release = deferred<void>();
  mocks.setClientSettings.mockImplementationOnce(async (settings) => {
    entered.resolve();
    await release.promise;
    durable = settings;
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

async function drainSettings() {
  await persistClientSettingsUpdate((settings) => settings);
}

async function mountHook<A>(useHook: () => A): Promise<() => A> {
  let value!: A;
  function Probe() {
    const current = useHook();
    useLayoutEffect(() => {
      value = current;
    });
    return null;
  }
  await act(() => {
    renderer = create(createElement(Probe));
  });
  return () => value;
}

function click(label: string): Promise<void> {
  const button = renderer!.root
    .findAllByType("button")
    .find((item) => item.props.children === label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  return Promise.resolve(button!.props.onClick());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetClientSettingsPersistenceForTests();
  select("conversation");
  mocks.getClientSettings.mockReset().mockImplementation(async () => durable);
  mocks.setClientSettings.mockReset().mockImplementation(async (settings) => {
    durable = settings;
  });
  mocks.openProject.mockReset().mockResolvedValue(PROJECT);
  mocks.newThread.mockReset().mockImplementation(async (_project, options) => {
    if (options?.newDraftPrompt !== undefined) {
      useComposerDraftStore.getState().setPrompt(DRAFT, options.newDraftPrompt);
    }
    mocks.router.state.location.href = `/draft/${DRAFT}`;
    return { draftId: DRAFT, threadId: THREAD };
  });
  mocks.router.state.location.href = "/getting-started";
  mocks.navigate.mockClear();
  mocks.configs.clear();
  mocks.configs.set(ENVIRONMENT, { providers: [], settings: DEFAULT_SERVER_SETTINGS });
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("queued getting started persistence", () => {
  it("records a submission made while its task's tracking save is still pending", async () => {
    const gate = holdNextSave();
    const generation = getClientSettings().gettingStarted.generation;
    const tracking = updateGettingStarted({
      type: "track",
      chapter: "conversation",
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      at: AT,
      generation,
    });
    await gate.entered;
    expect(getClientSettings().gettingStarted.tasks).toEqual([]);

    recordGettingStartedSubmission({
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      messageId: "sent-before-tracking-published",
      generation,
    });
    gate.release();
    expect(await tracking).toBe(true);
    await drainSettings();

    expect(durable.gettingStarted.tasks[0]?.messageIds).toEqual(["sent-before-tracking-published"]);
    expect(getClientSettings()).toEqual(durable);
    expect(durable.gettingStarted.completed).toEqual([]);
  });

  it("does not bind a queued submission to a newly restarted attempt in the same thread", async () => {
    const generation = getClientSettings().gettingStarted.generation;
    const gate = holdNextSave();
    const restarting = updateGettingStarted({ type: "restart" });
    await gate.entered;
    const tracking = updateGettingStarted({
      type: "track",
      chapter: "conversation",
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      at: AT,
      generation: generation + 1,
    });
    recordGettingStartedSubmission({
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      messageId: "old-attempt-submission",
      generation,
    });
    gate.release();
    await Promise.all([restarting, tracking]);
    await drainSettings();

    expect(durable.gettingStarted.generation).toBe(generation + 1);
    expect(durable.gettingStarted.tasks[0]?.messageIds).toEqual([]);
  });

  it.each(["next", "pause"] as const)(
    "a pending atomic %s acknowledgement cannot override a newer chapter selection",
    async (continuation) => {
      select("welcome");
      const gate = holdNextSave();
      const continuing = updateGettingStarted({
        type: "acknowledge",
        chapter: "welcome",
        continue: continuation,
        generation: getClientSettings().gettingStarted.generation,
        fromChapter: "welcome",
      });
      await gate.entered;
      const selection = updateGettingStarted({ type: "select", chapter: "files" });
      gate.release();
      await Promise.all([continuing, selection]);
      await drainSettings();

      expect(durable.gettingStarted).toMatchObject({
        activeChapter: "files",
        completed: ["welcome"],
        open: true,
        paused: false,
      });
    },
  );
});

describe("delayed draft preparation", () => {
  it.each(["pause", "restart", "select"] as const)(
    "cancels preparation as soon as %s is requested while its save is pending",
    async (interruption) => {
      const project = deferred<typeof PROJECT>();
      const entered = deferred<void>();
      mocks.openProject.mockImplementationOnce(() => {
        entered.resolve();
        return project.promise;
      });
      const actions = await mountHook(() => useGettingStartedActions(ENVIRONMENT));
      let preparing!: Promise<void>;
      await act(async () => {
        preparing = actions().prepare("conversation", "Practice prompt");
        await entered.promise;
      });
      const gate = holdNextSave();
      const cancelling = updateGettingStarted(
        interruption === "select" ? { type: "select", chapter: "files" } : { type: interruption },
      );
      await gate.entered;
      expect(getClientSettings().gettingStarted.paused).toBe(false);
      try {
        project.resolve(PROJECT);
        await act(async () => {
          await Promise.resolve();
        });
        expect(mocks.newThread).not.toHaveBeenCalled();
        expect(useComposerDraftStore.getState().getComposerDraft(DRAFT)).toBeNull();
      } finally {
        gate.release();
        await act(async () => {
          await Promise.all([cancelling, preparing]);
          await drainSettings();
        });
      }
    },
  );

  it("keeps a user's replacement prompt when Ideas tracking finishes later", async () => {
    select("ideas");
    const open = await mountHook(() => useOpenIdeaDraft(ENVIRONMENT));
    const gate = holdNextSave();
    let opening!: ReturnType<ReturnType<typeof useOpenIdeaDraft>>;
    await act(async () => {
      opening = open()(IDEA);
      await gate.entered;
    });
    expect(useComposerDraftStore.getState().getComposerDraft(DRAFT)?.prompt).toBe("Original idea");
    useComposerDraftStore.getState().setPrompt(DRAFT, "User replacement while saving");
    gate.release();
    await act(async () => {
      await opening;
      await drainSettings();
    });

    expect(useComposerDraftStore.getState().getComposerDraft(DRAFT)?.prompt).toBe(
      "User replacement while saving",
    );
    expect(durable.gettingStarted.tasks).toMatchObject([{ chapter: "ideas", threadId: THREAD }]);
    expect(durable.gettingStarted.completed).toEqual([]);
  });

  it.each(["pause", "select", "restart", "navigate"] as const)(
    "does not open or fill a practice draft after %s while the workspace is opening",
    async (interruption) => {
      const project = deferred<typeof PROJECT>();
      const entered = deferred<void>();
      mocks.openProject.mockImplementationOnce(() => {
        entered.resolve();
        return project.promise;
      });
      const actions = await mountHook(() => useGettingStartedActions(ENVIRONMENT));
      let preparing!: Promise<void>;
      await act(async () => {
        preparing = actions().prepare("conversation", "Practice prompt");
        await entered.promise;
      });
      expect(actions().pending).toBe(true);
      if (interruption === "navigate") {
        mocks.router.state.location.href = "/another/thread";
      } else {
        await updateGettingStarted(
          interruption === "select" ? { type: "select", chapter: "files" } : { type: interruption },
        );
      }
      const interrupted = getClientSettings().gettingStarted;
      project.resolve(PROJECT);
      await act(async () => {
        await preparing;
        await drainSettings();
      });

      expect(mocks.newThread).not.toHaveBeenCalled();
      expect(useComposerDraftStore.getState().getComposerDraft(DRAFT)).toBeNull();
      expect(getClientSettings().gettingStarted).toEqual(interrupted);
      expect(actions().pending).toBe(false);
      expect(actions().error).toBeNull();
    },
  );

  it("does not close the chapter selected while a prepared task is saving", async () => {
    const actions = await mountHook(() => useGettingStartedActions(ENVIRONMENT));
    const gate = holdNextSave();
    let preparing!: Promise<void>;
    await act(async () => {
      preparing = actions().prepare("conversation", "Practice prompt");
      await gate.entered;
    });
    const selection = updateGettingStarted({ type: "select", chapter: "files" });
    gate.release();
    await act(async () => {
      await preparing;
      await selection;
      await drainSettings();
    });

    expect(durable.gettingStarted).toMatchObject({ activeChapter: "files", open: true });
    expect(useComposerDraftStore.getState().getComposerDraft(DRAFT)?.prompt).toBe(
      "Practice prompt",
    );
  });
});

describe("chapter acknowledgement controls", () => {
  const controls = [
    { chapter: "welcome", button: "Let's try a conversation" },
    { chapter: "ready", button: "Keep working" },
  ] as const;

  it.each(
    controls.flatMap((control) =>
      (["Select Files", "Restart"] as const).map((interruption) => ({ ...control, interruption })),
    ),
  )(
    "$button respects $interruption while its acknowledgement is saving",
    async ({ chapter, button, interruption }) => {
      select(chapter);
      await act(() => {
        renderer = create(createElement(GettingStartedHost));
      });
      const gate = holdNextSave();
      let continuing!: Promise<void>;
      await act(async () => {
        continuing = click(button);
        await gate.entered;
      });
      await act(() => click(interruption));
      gate.release();
      await act(async () => {
        await continuing;
        await drainSettings();
      });

      expect(durable.gettingStarted).toMatchObject({
        activeChapter: interruption === "Restart" ? "welcome" : "files",
        completed: interruption === "Restart" ? [] : [chapter],
        open: true,
        paused: false,
      });
    },
  );

  it.each(controls)(
    "$button leaves progress unchanged when saving fails",
    async ({ chapter, button }) => {
      select(chapter);
      const before = getClientSettings().gettingStarted;
      await act(() => {
        renderer = create(createElement(GettingStartedHost));
      });
      mocks.setClientSettings.mockRejectedValueOnce(new Error("storage unavailable"));
      await act(async () => {
        await click(button);
        await drainSettings();
      });

      expect(durable.gettingStarted).toEqual(before);
      expect(getClientSettings().gettingStarted).toEqual(before);
    },
  );
});
