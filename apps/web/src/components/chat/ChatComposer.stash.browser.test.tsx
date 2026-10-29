import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act, render, stubGlobal } from "../../../test/render";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { useComposerDraftStore } from "../../composerDraftStore";
import { usePromptStashStore, writePromptStashStorageForTest } from "../../promptStashStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { attachmentEnvironment } from "../../state/attachments";
import { toastManager } from "../ui/toast";

const network = vi.hoisted(() => ({ command: vi.fn(), query: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => network.command(...args),
  executeAtomQuery: (...args: unknown[]) => network.query(...args),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  readPreparedConnection: () => ({ httpBaseUrl: "https://stash.test/" }),
}));
vi.mock("../../connection/catalog", async (original) => {
  const actual = await original<typeof import("../../connection/catalog")>();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      stateAtom: Atom.family(() => Atom.make(AsyncResult.success({ phase: "connected" }))),
    },
  };
});

function setup({ localPath = true, autoComplete = true, uploadStatus = 204 } = {}) {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  const environmentId = EnvironmentId.make("stash-environment");
  const threadId = ThreadId.make("stash-thread");
  const target = scopeThreadRef(environmentId, threadId);
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
  useAttachmentUploadStore.setState({ uploadsByImageId: {} });
  const requests: { complete: (status?: number) => void }[] = [];
  let resolveUploadStarted: () => void = () => {};
  const uploadStarted = new Promise<void>((resolve) => {
    resolveUploadStarted = resolve;
  });
  network.command.mockReset().mockImplementation(async (_registry, command, input) =>
    command === attachmentEnvironment.createUploadUrl
      ? {
          _tag: "Success",
          value: {
            attachmentId: `pending-${input.input.name}`,
            relativeUrl: "/api/attachments/upload/synthetic",
            expiresAt: 1,
          },
        }
      : { _tag: "Success", value: undefined },
  );
  network.query.mockReset().mockResolvedValue({ _tag: "Success", value: "/synthetic-asset" });
  class UploadRequest {
    status = 0;
    timeout = 0;
    upload = { addEventListener() {} };
    listeners = new Map<string, () => void>();
    open() {}
    setRequestHeader() {}
    addEventListener(event: string, callback: () => void) {
      this.listeners.set(event, callback);
    }
    send() {
      requests.push(this);
      resolveUploadStarted();
      if (autoComplete) this.complete(uploadStatus);
    }
    abort() {
      this.listeners.get("abort")?.();
    }
    complete(status = 204) {
      this.status = status;
      this.listeners.get("load")?.();
    }
  }
  const bridge = {
    getPathForFile: () => (localPath ? "C:\\synthetic\\notes.txt" : null),
    getLocalEnvironmentBootstraps: () => [{ id: "primary", runningDistro: null }],
    getClientPlatform: () => "win32",
    getClientSettings: async () => DEFAULT_CLIENT_SETTINGS,
  };
  const props: ChatComposerProps = {
    composerDraftTarget: target,
    environmentId,
    desktopLocalBackendId: "primary",
    canOperateThread: true,
    attachmentUploadsCapabilityKnown: true,
    supportsAttachmentUploads: true,
    supportsQuestionAttachments: true,
    maxFileAttachmentBytes: 1024,
    routeKind: "server",
    routeThreadRef: target,
    draftId: null,
    multipleModelSelections: null,
    supportsMultipleModels: false,
    onMultipleModelSelectionsChange() {},
    activeThreadId: threadId,
    activeThreadEnvironmentId: environmentId,
    activeThread: undefined,
    activeThreadShell: null,
    promptHistoryMessages: [],
    isServerThread: true,
    isLocalDraftThread: false,
    forceExpandedOnMobile: true,
    projectSelectionRequired: false,
    phase: "ready",
    canInterrupt: false,
    isConnecting: false,
    isSendBusy: false,
    canResume: false,
    sendDisabledReason: null,
    isPreparingWorktree: false,
    isCompacting: false,
    bannerItems: [],
    resumeCompactionTokens: null,
    keepFullHistory: false,
    onToggleKeepFullHistory() {},
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    threadSyncPhase: null,
    runtimeMode: "auto",
    interactionMode: "default",
    lockedProvider: null,
    providerStatuses: [
      {
        driver: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        version: null,
        checkedAt: "2026-10-23T00:00:00Z",
        models: [
          { slug: "synthetic-model", name: "Synthetic model", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
    providerCatalogKnown: true,
    activeProjectDefaultModelSelection: null,
    activeThreadModelSelection: null,
    activeProjectId: null,
    activeContextWindow: null,
    compactThreadUnavailable: true,
    compactDisabled: true,
    compactDisabledReason: null,
    resolvedTheme: "light",
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    terminalOpen: false,
    gitCwd: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: undefined,
    restingControlsHost: null,
    restingControlsHaveLeadingContext: false,
    onRestingControlsVisibilityChange() {},
    getTimelineScrollableNode: () => null,
    isTimelineAtLogicalEnd: () => true,
    timelineOverflows: false,
    onComposerOverlayHeightChange() {},
    onRestingChange() {},
    promptRef: { current: "" },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerRef: createRef(),
    onPageScrollKeyDown() {},
    onPageScrollKeyUp() {},
    onPageScrollRelease() {},
    editingQueuedAttachments: null,
    onRemoveEditingQueuedAttachment() {},
    onCompactContext() {},
    onSend() {},
    onResume() {},
    onInterrupt() {},
    onImplementPlanInNewThread() {},
    onRespondToApproval: async () => undefined,
    onSelectActivePendingUserInputOption() {},
    onAdvanceActivePendingUserInput() {},
    onDismissActivePendingUserInput() {},
    onPreviousActivePendingUserInputQuestion() {},
    onChangeActivePendingUserInputCustomAnswer() {},
    onProviderModelSelect() {},
    onOpenProviderSetup() {},
    getModelDisabledReason: () => null,
    toggleInteractionMode() {},
    handleRuntimeModeChange() {},
    handleInteractionModeChange() {},
    focusComposer() {},
    scheduleComposerFocus() {},
    setThreadError() {},
    onExpandImage() {},
    onFileOpen() {},
  };
  return {
    props,
    target,
    requests,
    bridge,
    UploadRequest,
    uploadStarted,
    [Symbol.dispose]() {
      platform.mockRestore();
      for (const id of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId))
        releaseAttachmentUpload(id);
      useComposerDraftStore.setState({ draftsByThreadKey: {} });
      usePromptStashStore.setState({ entries: [] });
      writePromptStashStorageForTest("");
    },
  };
}

async function pickFile(container: HTMLElement) {
  const file = new File(["synthetic notes"], "notes.txt", { type: "text/plain" });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  await act(() => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).not.toBeNull();
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return file;
}

async function stash() {
  await act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
}

// regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
it("stashes and restores a native local file only after the user requests Stash", async () => {
  using fixture = setup();
  using _bridge = stubGlobal("desktopBridge", fixture.bridge);
  using _xhr = stubGlobal("XMLHttpRequest", fixture.UploadRequest);
  using _toast = vi.spyOn(toastManager, "add");
  useComposerDraftStore.getState().setPrompt(fixture.target, "Keep my notes");
  await using screen = await render(<ChatComposer {...fixture.props} />);
  await expect.element(screen.getByTestId("composer-editor")).toBeInTheDocument();
  const file = await pickFile(screen.container);
  const attachment = useComposerDraftStore.getState().getComposerDraft(fixture.target)!.files[0]!;
  expect(attachment.file).toBe(file);
  expect(attachment.path).toBe("C:\\synthetic\\notes.txt");
  expect(fixture.requests).toHaveLength(0);
  expect(readAttachmentUpload(attachment.id)).toBeUndefined();
  await expect
    .element(screen.getByRole("button", { name: "Submit message", exact: true }))
    .toBeEnabled();
  await stash();
  await act(() => awaitAttachmentUploads([attachment.id]));
  expect(
    usePromptStashStore.getState().entries,
    JSON.stringify({
      toasts: _toast.mock.calls,
      upload: readAttachmentUpload(attachment.id),
      requests: fixture.requests.length,
    }),
  ).toHaveLength(1);
  expect(usePromptStashStore.getState().entries[0]).toMatchObject({
    prompt: expect.stringContaining("Keep my notes"),
    files: [
      {
        id: attachment.id,
        attachmentId: "pending-notes.txt",
        environmentId: fixture.props.environmentId,
      },
    ],
  });
  expect(usePromptStashStore.getState().entries[0]?.files?.[0]).not.toHaveProperty("path");
  expect(
    useComposerDraftStore.getState().getComposerDraft(fixture.target)?.files ?? [],
  ).toHaveLength(0);
  await stash();
  expect(usePromptStashStore.getState().entries).toHaveLength(0);
  const restored = useComposerDraftStore.getState().getComposerDraft(fixture.target)!;
  expect(restored.prompt).toContain("Keep my notes");
  expect(restored.files[0]).toMatchObject({
    file: null,
    uploadedAttachmentId: "pending-notes.txt",
  });
  expect(restored.files[0]?.path).toBeUndefined();
  expect(
    getUploadedAttachments({ environmentId: fixture.props.environmentId, images: restored.files }),
  ).toMatchObject([{ type: "file", id: "pending-notes.txt" }]);
});

// regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
it("waits for an existing fallback upload and deduplicates repeated Stash", async () => {
  using fixture = setup({ localPath: false, autoComplete: false });
  using _bridge = stubGlobal("desktopBridge", fixture.bridge);
  using _xhr = stubGlobal("XMLHttpRequest", fixture.UploadRequest);
  useComposerDraftStore.getState().setPrompt(fixture.target, "Pending fallback");
  await using screen = await render(<ChatComposer {...fixture.props} />);
  await expect.element(screen.getByTestId("composer-editor")).toBeInTheDocument();
  await pickFile(screen.container);
  await fixture.uploadStarted;
  const original = useComposerDraftStore.getState().getComposerDraft(fixture.target)!;
  const attachment = original.files[0]!;
  expect(attachment.path).toBeNull();
  await stash();
  await stash();
  expect(usePromptStashStore.getState().entries).toHaveLength(0);
  expect(useComposerDraftStore.getState().getComposerDraft(fixture.target)?.files[0]?.file).toBe(
    attachment.file,
  );
  expect(fixture.requests).toHaveLength(1);
  await act(async () => {
    fixture.requests[0]!.complete();
    await awaitAttachmentUploads([attachment.id]);
  });
  expect(usePromptStashStore.getState().entries).toHaveLength(1);
  expect(usePromptStashStore.getState().entries[0]?.prompt).toBe(original.prompt.trim());
  expect(fixture.requests).toHaveLength(1);
});

// regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
it("preserves live files, images and context when the explicit upload fails", async () => {
  using fixture = setup({ uploadStatus: 500 });
  using _bridge = stubGlobal("desktopBridge", fixture.bridge);
  using _xhr = stubGlobal("XMLHttpRequest", fixture.UploadRequest);
  using toasts = vi.spyOn(toastManager, "add");
  useComposerDraftStore.getState().setPrompt(fixture.target, "Keep everything");
  await using screen = await render(<ChatComposer {...fixture.props} />);
  await expect.element(screen.getByTestId("composer-editor")).toBeInTheDocument();
  await pickFile(screen.container);
  await act(() => {
    const store = useComposerDraftStore.getState();
    const image = new File(["synthetic image bytes"], "keep.png", { type: "image/png" });
    store.addImages(fixture.target, [
      {
        type: "image",
        id: "kept-image",
        name: image.name,
        mimeType: image.type,
        sizeBytes: image.size,
        file: image,
        previewUrl: URL.createObjectURL(image),
      },
    ]);
    store.addTerminalContexts(fixture.target, [
      {
        id: "kept-terminal",
        threadId: fixture.props.activeThreadId!,
        terminalId: "terminal",
        terminalLabel: "Terminal",
        lineStart: 1,
        lineEnd: 1,
        text: "synthetic context",
        createdAt: "2026-10-23T00:00:00Z",
      },
    ]);
  });
  const original = useComposerDraftStore.getState().getComposerDraft(fixture.target)!;
  await stash();
  await act(() => awaitAttachmentUploads(original.files.map((file) => file.id)));
  expect(usePromptStashStore.getState().entries).toHaveLength(0);
  const current = useComposerDraftStore.getState().getComposerDraft(fixture.target)!;
  expect(current.prompt).toBe(original.prompt);
  expect(current.files[0]?.file).toBe(original.files[0]?.file);
  expect(current.images).toBe(original.images);
  expect(current.terminalContexts).toBe(original.terminalContexts);
  expect(toasts).toHaveBeenCalledWith(
    expect.objectContaining({ title: "File upload did not finish for the stash" }),
  );
});

// regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
it.each(["capability", "size", "permission"] as const)(
  "keeps a native file when Stash fails the %s check",
  async (failure) => {
    using fixture = setup();
    using _bridge = stubGlobal("desktopBridge", fixture.bridge);
    using _xhr = stubGlobal("XMLHttpRequest", fixture.UploadRequest);
    using toasts = vi.spyOn(toastManager, "add");
    useComposerDraftStore.getState().setPrompt(fixture.target, "Keep local file");
    await using screen = await render(<ChatComposer {...fixture.props} />);
    await expect.element(screen.getByTestId("composer-editor")).toBeInTheDocument();
    await pickFile(screen.container);
    const original = useComposerDraftStore.getState().getComposerDraft(fixture.target)!;
    await screen.rerender(
      <ChatComposer
        {...fixture.props}
        supportsAttachmentUploads={failure !== "capability"}
        canOperateThread={failure !== "permission"}
        maxFileAttachmentBytes={failure === "size" ? 1 : 1024}
      />,
    );
    await stash();
    expect(fixture.requests).toHaveLength(0);
    expect(usePromptStashStore.getState().entries).toHaveLength(0);
    expect(useComposerDraftStore.getState().getComposerDraft(fixture.target)?.files[0]?.file).toBe(
      original.files[0]?.file,
    );
    expect(toasts).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not stash files" }),
    );
  },
);

// regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
it("keeps a newer draft when it changes during the explicit upload", async () => {
  using fixture = setup({ autoComplete: false });
  using _bridge = stubGlobal("desktopBridge", fixture.bridge);
  using _xhr = stubGlobal("XMLHttpRequest", fixture.UploadRequest);
  using toasts = vi.spyOn(toastManager, "add");
  useComposerDraftStore.getState().setPrompt(fixture.target, "Original words");
  await using screen = await render(<ChatComposer {...fixture.props} />);
  await expect.element(screen.getByTestId("composer-editor")).toBeInTheDocument();
  await pickFile(screen.container);
  const attachment = useComposerDraftStore.getState().getComposerDraft(fixture.target)!.files[0]!;
  await stash();
  await fixture.uploadStarted;
  await act(() => useComposerDraftStore.getState().setPrompt(fixture.target, "Newer words"));
  await act(async () => {
    fixture.requests[0]!.complete();
    await awaitAttachmentUploads([attachment.id]);
  });
  expect(usePromptStashStore.getState().entries).toHaveLength(0);
  expect(useComposerDraftStore.getState().getComposerDraft(fixture.target)?.prompt).toBe(
    "Newer words",
  );
  expect(useComposerDraftStore.getState().getComposerDraft(fixture.target)?.files[0]?.file).toBe(
    attachment.file,
  );
  expect(toasts).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Draft changed while preparing the stash" }),
  );
});

// regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
it("keeps both drafts when navigation happens during the explicit upload", async () => {
  using fixture = setup({ autoComplete: false });
  using _bridge = stubGlobal("desktopBridge", fixture.bridge);
  using _xhr = stubGlobal("XMLHttpRequest", fixture.UploadRequest);
  useComposerDraftStore.getState().setPrompt(fixture.target, "Original route");
  await using screen = await render(<ChatComposer {...fixture.props} />);
  await expect.element(screen.getByTestId("composer-editor")).toBeInTheDocument();
  await pickFile(screen.container);
  const attachment = useComposerDraftStore.getState().getComposerDraft(fixture.target)!.files[0]!;
  await stash();
  await fixture.uploadStarted;
  const other = scopeThreadRef(fixture.props.environmentId, ThreadId.make("other-thread"));
  await act(() => useComposerDraftStore.getState().setPrompt(other, "Other draft"));
  await screen.rerender(
    <ChatComposer
      {...fixture.props}
      composerDraftTarget={other}
      routeThreadRef={other}
      activeThreadId={other.threadId}
    />,
  );
  await act(async () => {
    fixture.requests[0]!.complete();
    await awaitAttachmentUploads([attachment.id]);
  });
  expect(usePromptStashStore.getState().entries).toHaveLength(0);
  expect(useComposerDraftStore.getState().getComposerDraft(fixture.target)?.files[0]?.file).toBe(
    attachment.file,
  );
  expect(useComposerDraftStore.getState().getComposerDraft(other)?.prompt).toBe("Other draft");
});

// regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
it("keeps the draft and uploaded reference if durable stash storage rejects the write", async () => {
  using fixture = setup();
  using _bridge = stubGlobal("desktopBridge", fixture.bridge);
  using _xhr = stubGlobal("XMLHttpRequest", fixture.UploadRequest);
  useComposerDraftStore.getState().setPrompt(fixture.target, "Durable or retained");
  await using screen = await render(<ChatComposer {...fixture.props} />);
  await expect.element(screen.getByTestId("composer-editor")).toBeInTheDocument();
  await pickFile(screen.container);
  const attachment = useComposerDraftStore.getState().getComposerDraft(fixture.target)!.files[0]!;
  const originalSetItem = Storage.prototype.setItem;
  using _storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key === "t3code:prompt-stash:v2")
      throw new DOMException("Synthetic quota failure", "QuotaExceededError");
    return originalSetItem.call(this, key, value);
  });
  await stash();
  await act(() => awaitAttachmentUploads([attachment.id]));
  expect(usePromptStashStore.getState().entries).toHaveLength(0);
  const retained = useComposerDraftStore.getState().getComposerDraft(fixture.target)!;
  expect(retained.prompt).toContain("Durable or retained");
  expect(retained.files[0]?.file).toBe(attachment.file);
  expect(retained.files[0]?.uploadedAttachmentId).toBe("pending-notes.txt");
});

// regression: #427 fix: preserve migration activity, native file stashes and fatal shutdown
it("does not consume a store edit that has not rendered at the Stash event", async () => {
  using fixture = setup();
  using _bridge = stubGlobal("desktopBridge", fixture.bridge);
  using _xhr = stubGlobal("XMLHttpRequest", fixture.UploadRequest);
  useComposerDraftStore.getState().setPrompt(fixture.target, "Rendered words");
  await using screen = await render(<ChatComposer {...fixture.props} />);
  await expect.element(screen.getByTestId("composer-editor")).toBeInTheDocument();
  await pickFile(screen.container);
  const file = useComposerDraftStore.getState().getComposerDraft(fixture.target)!.files[0]!;
  await act(() => {
    useComposerDraftStore.getState().setPrompt(fixture.target, "Newest words before render");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
  await act(() => awaitAttachmentUploads([file.id]));
  expect(usePromptStashStore.getState().entries).toHaveLength(0);
  expect(useComposerDraftStore.getState().getComposerDraft(fixture.target)?.prompt).toBe(
    "Newest words before render",
  );
  expect(useComposerDraftStore.getState().getComposerDraft(fixture.target)?.files[0]?.file).toBe(
    file.file,
  );
});
