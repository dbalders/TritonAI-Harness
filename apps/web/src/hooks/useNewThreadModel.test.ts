import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";

const harness = vi.hoisted(() => ({
  projectDefault: null as ModelSelection | null,
  params: { environmentId: "env", threadId: "old-glm" } as Record<string, string>,
  navigate: vi.fn(async () => {}),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({ defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: false }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({
    state: { matches: [{ params: harness.params }] },
    navigate: harness.navigate,
  }),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "separate",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("../state/entities", () => ({
  useProjects: () => [
    {
      id: "project",
      environmentId: "env",
      workspaceRoot: "/tmp/project",
      defaultThreadEnvMode: "local",
      defaultModelSelection: harness.projectDefault,
    },
  ],
  useThread: () => null,
  readThreadShell: (ref: { threadId: string }) =>
    ref.threadId === "old-glm"
      ? {
          modelSelection: { instanceId: "codex", model: "glm" },
          runtimeMode: "full-access",
          interactionMode: "default",
        }
      : null,
}));
const INSTANCE = ProviderInstanceId.make("codex");
const FLASH: ModelSelection = {
  instanceId: INSTANCE,
  model: "flash",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const GLM: ModelSelection = { instanceId: INSTANCE, model: "glm" };
const PROJECT = scopeProjectRef(EnvironmentId.make("env"), ProjectId.make("project"));
const selectedModel = (draftId: DraftId) =>
  useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[INSTANCE];

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
    stickyRuntimeMode: null,
  });
  harness.projectDefault = null;
  harness.params = { environmentId: "env", threadId: "old-glm" };
  harness.navigate.mockClear();
  useComposerDraftStore.getState().setStickyModelSelection(FLASH);
});

describe("new task model intent", () => {
  it("starts on Flash after opening a saved GLM task, including its reasoning choice", async () => {
    const result = await useNewThreadHandler()(PROJECT);
    expect(result).not.toBeNull();
    expect(selectedModel(result!.draftId)).toEqual(FLASH);
  });

  it("ignores a GLM composer override on an older task", async () => {
    useComposerDraftStore
      .getState()
      .setModelSelection(scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("old-glm")), GLM, {
        explicit: true,
      });
    const result = await useNewThreadHandler()(PROJECT);
    expect(selectedModel(result!.draftId)).toEqual(FLASH);
  });

  it("refreshes an empty reused draft from the remembered choice", async () => {
    const open = useNewThreadHandler();
    const first = await open(PROJECT);
    useComposerDraftStore.getState().setModelSelection(first!.draftId, GLM);
    const second = await open(PROJECT);
    expect(second!.draftId).toBe(first!.draftId);
    expect(selectedModel(second!.draftId)).toEqual(FLASH);
  });

  it("preserves an explicit pick in an unsent draft", async () => {
    const open = useNewThreadHandler();
    const first = await open(PROJECT);
    useComposerDraftStore
      .getState()
      .setModelSelection(first!.draftId, GLM, { explicit: true, replaceOptions: true });
    const second = await open(PROJECT);
    expect(selectedModel(second!.draftId)).toEqual(GLM);
  });

  it("applies a project override without replacing the remembered model, then follows reset", async () => {
    harness.projectDefault = GLM;
    const pinned = await useNewThreadHandler()(PROJECT);
    expect(selectedModel(pinned!.draftId)).toEqual(GLM);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[INSTANCE]).toEqual(
      FLASH,
    );
    harness.projectDefault = null;
    const unpinned = await useNewThreadHandler()(PROJECT);
    expect(selectedModel(unpinned!.draftId)).toEqual(FLASH);
  });
});
