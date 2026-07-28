import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Project } from "../types";

const testState = vi.hoisted(() => ({
  projects: [] as unknown[],
  primaryEnvironmentId: "env-primary",
  handleNewThread: vi.fn(),
  createProject: vi.fn(),
  openCommandPalette: vi.fn(),
}));

const hooks = vi.hoisted(() => ({
  useCallback<T>(callback: T): T {
    return callback;
  },
  useEffect(): void {},
  useMemo<T>(factory: () => T): T {
    return factory();
  },
  useRef<T>(initialValue: T): { current: T } {
    return { current: initialValue };
  },
  useState<T>(initialValue: T | (() => T)): [T, (nextValue: T | ((current: T) => T)) => void] {
    return [
      typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
      vi.fn(),
    ];
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: (size: number) => Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel")),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => {
    if (atom === "environment-server-configs") return new Map();
    return [];
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => ({ navigate: vi.fn() }),
}));

vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: testState.openCommandPalette,
}));

vi.mock("../composerDraftStore", () => {
  const store = {
    getDraftSession: () => null,
    getDraftThreadByProjectRef: () => null,
  };
  return {
    useComposerDraftStore: Object.assign(
      (selector: (state: typeof store) => unknown) => selector(store),
      { getState: () => store },
    ),
  };
});

vi.mock("../env", () => ({ isElectron: false }));

vi.mock("../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));

vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: testState.handleNewThread,
    routeThreadRef: null,
  }),
}));

vi.mock("../hooks/useNowMinute", () => ({
  useNowMinute: () => "2026-01-01T00:00",
}));

vi.mock("../hooks/useSettings", () => {
  const clientSettings = {
    confirmThreadDelete: false,
    sidebarAutoSettleAfterDays: null,
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
    sidebarProjectSortOrder: "manual",
  };
  const primarySettings = {
    textGenerationModelSelection: {
      instanceId: "codex",
      model: "gpt-5-codex",
    },
  };
  return {
    useClientSettings: (select: (settings: typeof clientSettings) => unknown) =>
      select(clientSettings),
    usePrimarySettings: (select: (settings: typeof primarySettings) => unknown) =>
      select(primarySettings),
    useUpdateClientSettings: () => vi.fn(),
  };
});

vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    deleteThread: vi.fn(),
    settleThread: vi.fn(),
    snoozeThread: vi.fn(),
    unsettleThread: vi.fn(),
    unsnoozeThread: vi.fn(),
  }),
}));

vi.mock("../shortcutModifierState", () => ({
  useShortcutModifierState: () => ({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  }),
}));

vi.mock("../state/entities", () => ({
  useProjects: () => testState.projects,
  useThreadShells: () => [],
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: testState.primaryEnvironmentId,
        label: "Local",
      },
    ],
  }),
  usePrimaryEnvironmentId: () => testState.primaryEnvironmentId,
}));

vi.mock("../state/projects", () => ({
  projectEnvironment: {
    create: "create-project",
    delete: "delete-project",
    update: "update-project",
  },
}));

vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: "environment-server-configs",
  primaryServerKeybindingsAtom: "primary-server-keybindings",
  primaryServerProvidersAtom: "primary-server-providers",
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: { updateMetadata: "update-thread-metadata" },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "create-project" ? testState.createProject : vi.fn(),
}));

vi.mock("../terminalUiStateStore", () => ({
  selectThreadTerminalUiState: () => ({ terminalOpen: false }),
  useTerminalUiStateStore: (select: (state: { terminalUiStateByThreadKey: object }) => unknown) =>
    select({ terminalUiStateByThreadKey: {} }),
}));

vi.mock("../threadSelectionStore", () => {
  const store = {
    clearSelection: vi.fn(),
    hasSelection: () => false,
    rangeSelectTo: vi.fn(),
    removeFromSelection: vi.fn(),
    selectedThreadKeys: new Set<string>(),
    setAnchor: vi.fn(),
    toggleThread: vi.fn(),
  };
  return {
    useThreadSelectionStore: Object.assign(
      (selector: (state: typeof store) => unknown) => selector(store),
      { getState: () => store },
    ),
  };
});

vi.mock("../uiStateStore", () => {
  const store = {
    markThreadUnread: vi.fn(),
    projectOrder: [] as string[],
  };
  return {
    legacyProjectCwdPreferenceKey: (workspaceRoot: string) => workspaceRoot,
    useUiStateStore: Object.assign(
      (selector: (state: typeof store) => unknown) => selector(store),
      { getState: () => store },
    ),
  };
});

vi.mock("./ui/sidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui/sidebar")>();
  return {
    ...actual,
    useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
  };
});

import SidebarV2 from "./SidebarV2";

const primaryEnvironmentId = EnvironmentId.make("env-primary");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("regular-project"),
    environmentId: primaryEnvironmentId,
    title: "Regular project",
    workspaceRoot: "/tmp/regular-project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (!isValidElement(node)) return "";
  const props = node.props as {
    readonly children?: ReactNode;
    readonly render?: ReactNode;
  };
  return nodeText(props.children) + nodeText(props.render);
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (predicate(node)) return node;
  const props = node.props as {
    readonly children?: ReactNode;
    readonly render?: ReactNode;
  };
  return findElement(props.children, predicate) ?? findElement(props.render, predicate);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("SidebarV2 TritonAI Chats grouping", () => {
  beforeEach(() => {
    testState.projects = [];
    testState.primaryEnvironmentId = primaryEnvironmentId;
    testState.handleNewThread.mockReset().mockResolvedValue(undefined);
    testState.createProject.mockReset();
    testState.openCommandPalette.mockReset();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "MacIntel" },
    });
  });

  it("keeps Chats dedicated and non-destructive while ordinary new threads target a real project", async () => {
    const regularProject = makeProject();
    const chatsProject = makeProject({
      id: ProjectId.make("chats"),
      title: "Chats",
      workspaceRoot: "~/.tritonai-harness/chats",
    });
    testState.projects = [regularProject, chatsProject];

    const output = SidebarV2();

    expect(
      findElement(output, (element) => element.type === "span" && nodeText(element) === "Chats"),
    ).not.toBeNull();
    expect(
      findElement(
        output,
        (element) =>
          (element.props as { readonly "aria-label"?: string })["aria-label"] ===
          "Project actions for Regular project",
      ),
    ).not.toBeNull();
    expect(
      findElement(
        output,
        (element) =>
          (element.props as { readonly "aria-label"?: string })["aria-label"] ===
          "Project actions for Chats",
      ),
    ).toBeNull();

    const newThreadButton = findElement(
      output,
      (element) =>
        (element.props as { readonly "aria-label"?: string })["aria-label"] === "New thread",
    );
    expect(newThreadButton).not.toBeNull();
    if (!newThreadButton) throw new Error("Expected the ordinary new-thread button.");
    expect((newThreadButton.props as { readonly disabled?: boolean }).disabled).toBe(false);
    (newThreadButton.props as { readonly onClick: () => void }).onClick();

    expect(testState.handleNewThread).toHaveBeenCalledOnce();
    expect(testState.handleNewThread).toHaveBeenCalledWith({
      environmentId: primaryEnvironmentId,
      projectId: regularProject.id,
    });
    expect(testState.openCommandPalette).not.toHaveBeenCalled();

    const newChatButton = findElement(
      output,
      (element) =>
        (element.props as { readonly "aria-label"?: string })["aria-label"] === "New chat",
    );
    expect(newChatButton).not.toBeNull();
    if (!newChatButton) throw new Error("Expected the dedicated new-chat button.");
    (newChatButton.props as { readonly onClick: () => void }).onClick();
    await flushPromises();

    expect(testState.handleNewThread).toHaveBeenNthCalledWith(
      2,
      {
        environmentId: primaryEnvironmentId,
        projectId: chatsProject.id,
      },
      {
        branch: null,
        envMode: "local",
        worktreePath: null,
      },
    );
    expect(testState.createProject).not.toHaveBeenCalled();
  });
});
