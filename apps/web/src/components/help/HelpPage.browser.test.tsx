import {
  AuthDiagnosticsReadScope,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type HelpAskResult,
  type HelpContext,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal, type Screen } from "../../../test/render";

const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    askPermission: "help-ask-permission",
    environmentId: "host" as string | null,
    connection: {} as object | null,
    connected: true,
    diagnostics: true,
    orchestration: true,
    allowed: true,
    clientSettings: {} as ClientSettings,
    hydrateClientSettings: vi.fn<() => Promise<void>>(),
    getClientSettings: vi.fn<() => ClientSettings>(),
    data: null as HelpContext | null,
    isSuccess: false,
    error: null as string | null,
    failure: null as unknown,
    refresh: vi.fn(),
    contextAtom: vi.fn(() => "help-context"),
    ask: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    copy: vi.fn(async (_report: string, _label: string) => true),
    // The real hooks are atom subscriptions, so changes re-render subscribers without a parent render.
    version: 0,
    listeners,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
vi.mock(import("../../hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  writeTextToClipboard: state.copy as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  ensureClientSettingsHydrated: state.hydrateClientSettings,
  getClientSettings: state.getClientSettings as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const actual = await original();
  const useAtomValue = actual.useAtomValue as (...args: unknown[]) => unknown;
  return {
    ...actual,
    useAtomValue: ((...args: unknown[]) => {
      if (args[0] !== state.askPermission) return useAtomValue(...args);
      useSyncExternalStore(state.subscribe, () => state.version);
      return state.allowed;
    }) as never,
  };
});
vi.mock(import("../../state/environments"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const useVersion = () => useSyncExternalStore(state.subscribe, () => state.version);
  return {
    ...(await original()),
    usePrimaryEnvironmentId: (() => {
      useVersion();
      return state.environmentId;
    }) as never,
    useEnvironment: (() => {
      useVersion();
      return state.environmentId
        ? {
            label: "Primary test host",
            connection: { phase: state.connected ? "connected" : "disconnected" },
          }
        : null;
    }) as never,
  };
});
vi.mock(import("../../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const Option = await import("effect/Option");
  const contracts = await import("@t3tools/contracts");
  const useVersion = () => useSyncExternalStore(state.subscribe, () => state.version);
  return {
    ...(await original()),
    usePreparedConnection: (() => {
      useVersion();
      return state.connection ? Option.some(state.connection) : Option.none();
    }) as never,
    useEnvironmentScope: ((_id: unknown, scope: string) => {
      useVersion();
      return scope === contracts.AuthDiagnosticsReadScope ? state.diagnostics : state.orchestration;
    }) as never,
    readPreparedConnection: (() => state.connection) as never,
    readEnvironmentScope: ((_id: unknown, scope: string) =>
      scope === contracts.AuthDiagnosticsReadScope
        ? state.diagnostics
        : scope === contracts.AuthOrchestrationReadScope
          ? state.orchestration
          : state.allowed) as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      helpContext: state.contextAtom,
      askHelp: { ...actual.serverEnvironment.askHelp, permissionAtom: () => state.askPermission },
    } as never,
  };
});
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: unknown) => {
      useSyncExternalStore(state.subscribe, () => state.version);
      return {
        data: atom ? state.data : null,
        isSuccess: atom ? state.isSuccess : false,
        isPending: false,
        error: atom ? state.error : null,
        failure: atom ? state.failure : null,
        refresh: state.refresh,
      };
    }) as never,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.ask) as never,
}));
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: false }));

import { HelpPage } from "./HelpPage";

const context: HelpContext = {
  capturedAt: "2026-10-22T12:00:00Z",
  environmentId: EnvironmentId.make("host"),
  environmentName: "Fresh environment snapshot",
  version: "0.3.1",
  platform: "darwin",
  mode: "desktop",
  paths: [],
  providers: [],
  modelLabel: "Codex",
  diagnostics: {
    recordCount: 0,
    failureCount: 0,
    slowSpanCount: 0,
    partial: false,
    recentFailures: [],
  },
};
const answer: HelpAskResult = { answer: "Open Settings > Providers to check sign-in.", context };

function setup() {
  state.environmentId = "host";
  state.connection = {};
  state.connected = true;
  state.diagnostics = true;
  state.orchestration = true;
  state.allowed = true;
  state.clientSettings = { ...DEFAULT_CLIENT_SETTINGS };
  state.hydrateClientSettings.mockReset().mockResolvedValue(undefined);
  state.getClientSettings.mockReset().mockImplementation(() => state.clientSettings);
  state.data = null;
  state.isSuccess = false;
  state.error = null;
  state.failure = null;
  state.refresh.mockClear();
  state.contextAtom.mockClear();
  state.ask.mockReset().mockResolvedValue(AsyncResult.success(answer));
  state.copy.mockClear();
  state.version = 0;
  state.listeners.clear();
}

const mount = () => render(<HelpPage />);
async function publish() {
  await act(() => {
    state.version += 1;
    for (const listener of state.listeners) listener();
  });
}
const text = (screen: Screen) => screen.container.textContent ?? "";
const composer = (screen: Screen) =>
  screen.container.querySelector<HTMLTextAreaElement>("#help-question")!;
const sendButton = (screen: Screen) =>
  screen.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const button = (screen: Screen, label: string) =>
  [...screen.container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
const refreshButton = (screen: Screen) =>
  screen.container.querySelector<HTMLButtonElement>('[aria-label="Refresh environment snapshot"]')!;
const preview = (screen: Screen) => screen.container.querySelector("pre")!.textContent ?? "";
const feedbackField = (screen: Screen, id: string) =>
  screen.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#help-feedback-${id}`)!;
const includeConversation = (screen: Screen) =>
  screen.container.querySelector<HTMLElement>('#help-feedback [role="checkbox"]')!;

async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(screen: Screen) {
  await act(async () => screen.container.querySelector("form")!.requestSubmit());
}
async function captureSnapshot() {
  state.data = { ...context };
  state.isSuccess = true;
  await publish();
}
// The snapshot details stay collapsed by default; open them so snapshot assertions can fail.
async function openEnvironment(screen: Screen) {
  const disclosure = [...screen.container.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("This environment"),
  )!;
  if (disclosure.getAttribute("aria-expanded") === "false") await click(disclosure);
}

it("quick questions only fill the composer; Send produces a reply and follow-up uses it", async () => {
  setup();
  await using screen = await mount();
  await captureSnapshot();
  expect(text(screen)).toContain("Primary test host");
  expect(state.ask).not.toHaveBeenCalled();
  expect(state.hydrateClientSettings).not.toHaveBeenCalled();
  expect(state.getClientSettings).not.toHaveBeenCalled();
  await click(button(screen, "Why is my provider not responding?"));
  expect(composer(screen).value).toBe("Why is my provider not responding?");
  expect(document.activeElement).toBe(composer(screen));
  expect(state.ask).not.toHaveBeenCalled();
  expect(state.hydrateClientSettings).not.toHaveBeenCalled();
  await submit(screen);
  expect(text(screen)).toContain(answer.answer);
  expect(composer(screen).value).toBe("");
  await type(composer(screen), "How do I reconnect?");
  await submit(screen);
  expect(state.ask).toHaveBeenLastCalledWith({
    environmentId: "host",
    input: {
      client: expect.objectContaining({ surface: "web", settingsStatus: "ready" }),
      messages: [
        { role: "user", content: "Why is my provider not responding?" },
        { role: "assistant", content: answer.answer },
        { role: "user", content: "How do I reconnect?" },
      ],
    },
  });
});

it("renders the complete answer while sending only bounded history on a follow-up", async () => {
  setup();
  const suffix = "Finally, reconnect in Settings > Providers.";
  const fullAnswer = "x".repeat(16_000 - suffix.length) + suffix;
  state.ask.mockResolvedValue(AsyncResult.success({ ...answer, answer: fullAnswer }));
  await using screen = await mount();
  await captureSnapshot();
  await type(composer(screen), "How do I restore the provider?");
  await submit(screen);
  expect(text(screen)).toContain(fullAnswer);
  await type(composer(screen), "What comes next?");
  await submit(screen);
  expect(state.ask).toHaveBeenLastCalledWith({
    environmentId: "host",
    input: {
      client: expect.objectContaining({ surface: "web", settingsStatus: "ready" }),
      messages: [
        { role: "user", content: "How do I restore the provider?" },
        { role: "assistant", content: fullAnswer.slice(0, 8000) },
        { role: "user", content: "What comes next?" },
      ],
    },
  });
  expect(text(screen)).toContain(fullAnswer);
});

it("keeps a pending request through navigation and stops duplicate submission", async () => {
  setup();
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((done) => {
    resolve = done;
  });
  state.ask.mockReturnValue(response);
  await using first = await mount();
  await captureSnapshot();
  await type(composer(first), "Waiting question");
  await submit(first);
  expect(sendButton(first).disabled).toBe(true);
  await first.unmount();
  await using second = await mount();
  expect(text(second)).toContain("Help is preparing a response");
  await submit(second);
  expect(state.ask).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(AsyncResult.success(answer));
    await response;
  });
  expect(text(second)).toContain(answer.answer);
});

it("does not submit Shift+Enter or IME composition; Enter sends once and returns focus", async () => {
  setup();
  await using screen = await mount();
  await captureSnapshot();
  await type(composer(screen), "Keyboard question");
  const keyDown = (init: KeyboardEventInit) =>
    act(async () => {
      composer(screen).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
      );
    });
  composer(screen).focus();
  await keyDown({ shiftKey: true });
  await keyDown({ isComposing: true });
  await keyDown({ keyCode: 229 });
  expect(state.ask).not.toHaveBeenCalled();
  await keyDown({});
  expect(state.ask).toHaveBeenCalledTimes(1);
  expect(text(screen)).toContain(answer.answer);
  expect(document.activeElement).toBe(composer(screen));
});

it("keeps input and recovery after a top-level failure and retries only on request", async () => {
  setup();
  state.ask.mockResolvedValueOnce(
    AsyncResult.failure(Cause.die(new Error("private transport exception"))),
  );
  await using screen = await mount();
  await captureSnapshot();
  await type(composer(screen), "Please help reconnect");
  await submit(screen);
  expect(text(screen)).not.toContain("private transport exception");
  expect(composer(screen).value).toBe("Please help reconnect");
  expect(text(screen)).toContain("Providers");
  expect(text(screen)).toContain("Connections");
  expect(state.ask).toHaveBeenCalledTimes(1);
  await click(button(screen, "Retry response"));
  expect(text(screen)).toContain(answer.answer);
  expect(state.ask).toHaveBeenCalledTimes(2);
});

it.each(["diagnostics", "orchestration"])(
  "denied %s read makes no snapshot request but keeps feedback and settings available",
  async (scope) => {
    setup();
    if (scope === "diagnostics") state.diagnostics = false;
    else state.orchestration = false;
    await using screen = await mount();
    expect(state.contextAtom).not.toHaveBeenCalled();
    expect(sendButton(screen).disabled).toBe(true);
    expect(text(screen)).toContain("diagnostics:read");
    expect(text(screen)).toContain("orchestration:read");
    expect(text(screen)).toContain("Providers");
    await click(button(screen, "Prepare feedback"));
    expect(feedbackField(screen, "summary")).not.toBeNull();
    expect(text(screen)).toContain("Nothing is sent until you submit it in the issue tracker.");
    expect(text(screen)).toContain("App context unavailable");
  },
);

it("blocks Ask when operate scope is missing or context API fails without exposing the error", async () => {
  setup();
  state.allowed = false;
  await using screen = await mount();
  await captureSnapshot();
  await type(composer(screen), "Question");
  await submit(screen);
  expect(state.ask).not.toHaveBeenCalled();
  expect(sendButton(screen).disabled).toBe(true);
  expect(text(screen)).toContain("orchestration:operate");
  state.allowed = true;
  state.error = "unsupported method; private transport data";
  state.isSuccess = false;
  await publish();
  expect(text(screen)).not.toContain("private transport");
  expect(sendButton(screen).disabled).toBe(true);
});

it("read-only users with diagnostics and orchestration access can refresh while Ask stays disabled", async () => {
  setup();
  state.allowed = false;
  await using screen = await mount();
  expect(state.contextAtom).toHaveBeenCalled();
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await captureSnapshot();
  await openEnvironment(screen);
  expect(text(screen)).toContain("Fresh environment snapshot");
  expect(composer(screen).disabled).toBe(true);
  expect(sendButton(screen).disabled).toBe(true);
  expect(refreshButton(screen).disabled).toBe(false);
  await click(refreshButton(screen));
  expect(state.refresh).toHaveBeenCalledTimes(2);
  state.data = { ...context, environmentName: "Refreshed read-only snapshot" };
  await publish();
  expect(text(screen)).toContain("Refreshed read-only snapshot");
  expect(text(screen)).not.toContain("Fresh environment snapshot");
  await click(button(screen, "Prepare feedback"));
  expect(preview(screen)).toContain("App version: 0.3.1");
  await submit(screen);
  expect(state.ask).not.toHaveBeenCalled();
});

it("Refresh rechecks current read permissions and the prepared connection before requesting", async () => {
  setup();
  await using screen = await mount();
  await captureSnapshot();
  state.refresh.mockClear();
  state.diagnostics = false;
  await click(refreshButton(screen));
  expect(state.refresh).not.toHaveBeenCalled();
  state.diagnostics = true;
  state.orchestration = false;
  await click(refreshButton(screen));
  expect(state.refresh).not.toHaveBeenCalled();
  state.orchestration = true;
  state.connection = {};
  await click(refreshButton(screen));
  expect(state.refresh).not.toHaveBeenCalled();
});

it("reads fresh preferences on each actual send and retry without inferring on open", async () => {
  setup();
  state.ask.mockResolvedValueOnce(AsyncResult.failure(Cause.die(new Error("private failure"))));
  await using screen = await mount();
  await captureSnapshot();
  expect(state.hydrateClientSettings).not.toHaveBeenCalled();
  state.clientSettings = { ...DEFAULT_CLIENT_SETTINGS, composerRichTextEnabled: false };
  await type(composer(screen), "Why is the composer plain text?");
  await submit(screen);
  expect(state.ask.mock.calls[0]?.[0]).toMatchObject({
    input: {
      client: {
        surface: "web",
        settingsStatus: "ready",
        settings: {
          entries: expect.arrayContaining([{ key: "composerRichTextEnabled", value: "false" }]),
        },
      },
    },
  });
  state.clientSettings = { ...state.clientSettings, composerRichTextEnabled: true };
  await click(button(screen, "Retry response"));
  expect(state.ask.mock.calls[1]?.[0]).toMatchObject({
    input: {
      client: {
        settings: {
          entries: expect.arrayContaining([{ key: "composerRichTextEnabled", value: "true" }]),
        },
      },
    },
  });
  expect(state.hydrateClientSettings).toHaveBeenCalledTimes(2);
  expect(state.getClientSettings).toHaveBeenCalledTimes(2);
});

it("captures current desktop permissions on each send separately from the remote host", async () => {
  setup();
  const readiness = {
    enabled: true,
    available: true,
    running: false,
    accessibilityPermission: false,
    screenRecordingPermission: null as boolean | null,
  };
  const getComputerUseState = vi.fn(async () => ({ ...readiness }));
  const mutate = vi.fn();
  using _bridge = stubGlobal("desktopBridge", {
    getClientPlatform: () => "win32",
    getComputerUseState,
    setComputerUseEnabled: mutate,
    requestSystemPermission: mutate,
  });
  await using screen = await mount();
  state.data = { ...context, mode: "server", platform: "linux" };
  state.isSuccess = true;
  await publish();
  expect(getComputerUseState).not.toHaveBeenCalled();
  await type(composer(screen), "Can this desktop control my screen?");
  await submit(screen);
  expect(state.ask.mock.calls[0]?.[0]).toMatchObject({
    input: { client: { surface: "desktop", platform: "win32", computerUse: { ...readiness } } },
  });
  readiness.accessibilityPermission = true;
  readiness.screenRecordingPermission = true;
  await type(composer(screen), "Are the permissions ready now?");
  await submit(screen);
  expect(state.ask.mock.calls[1]?.[0]).toMatchObject({
    input: { client: { surface: "desktop", platform: "win32", computerUse: { ...readiness } } },
  });
  expect(getComputerUseState).toHaveBeenCalledTimes(2);
  expect(mutate).not.toHaveBeenCalled();
});

it.each(["clear", "new connection", "diagnostics", "orchestration", "operate"])(
  "a late hydration read after %s cannot start inference",
  async (change) => {
    setup();
    let finish!: () => void;
    const hydration = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.hydrateClientSettings.mockReturnValueOnce(hydration);
    await using first = await mount();
    await captureSnapshot();
    await type(composer(first), "Question awaiting local preferences");
    await submit(first);
    expect(state.ask).not.toHaveBeenCalled();
    if (change === "clear") {
      // A pending read survives navigation; Clear in the new mount must still cancel it.
      await first.unmount();
      await using second = await mount();
      await click(button(second, "Clear conversation"));
    } else if (change === "new connection") state.connection = {};
    else if (change === "diagnostics") state.diagnostics = false;
    else if (change === "orchestration") state.orchestration = false;
    else state.allowed = false;
    // No re-render is necessary for the current-connection/scope checks at completion.
    await act(async () => {
      finish();
      await hydration;
    });
    expect(state.ask).not.toHaveBeenCalled();
    expect(state.getClientSettings).not.toHaveBeenCalled();
  },
);

it("Clear and resend of the same question does not let the older local read submit it twice", async () => {
  setup();
  let finishOld!: () => void;
  const oldHydration = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  state.hydrateClientSettings.mockReturnValueOnce(oldHydration);
  await using screen = await mount();
  await captureSnapshot();
  await type(composer(screen), "Same question");
  await submit(screen);
  await click(button(screen, "Clear conversation"));
  await type(composer(screen), "Same question");
  await submit(screen);
  expect(state.ask).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishOld();
    await oldHydration;
  });
  expect(state.ask).toHaveBeenCalledTimes(1);
  expect(text(screen)).toContain(answer.answer);
});

it("a local read keeps its actual send through navigation when the connection and access remain current", async () => {
  setup();
  let finish!: () => void;
  const hydration = new Promise<void>((resolve) => {
    finish = resolve;
  });
  state.hydrateClientSettings.mockReturnValueOnce(hydration);
  await using first = await mount();
  await captureSnapshot();
  await type(composer(first), "Question pending across navigation");
  await submit(first);
  await first.unmount();
  await using second = await mount();
  expect(text(second)).toContain("Help is preparing a response");
  expect(state.ask).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await hydration;
  });
  expect(state.ask).toHaveBeenCalledTimes(1);
  expect(text(second)).toContain(answer.answer);
});

it.each(["clear", "orchestration"])(
  "a late desktop readiness read after %s cannot start inference or request permissions",
  async (change) => {
    setup();
    let finish!: (value: unknown) => void;
    const readiness = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const getComputerUseState = vi.fn(() => readiness);
    const requestPermissions = vi.fn();
    using _bridge = stubGlobal("desktopBridge", {
      getComputerUseState,
      requestSystemPermission: requestPermissions,
      setComputerUseEnabled: requestPermissions,
    });
    await using screen = await mount();
    await captureSnapshot();
    await type(composer(screen), "Desktop permission question");
    await submit(screen);
    expect(getComputerUseState).toHaveBeenCalledTimes(1);
    if (change === "clear") await click(button(screen, "Clear conversation"));
    else state.orchestration = false;
    await act(async () => {
      finish({
        enabled: true,
        available: true,
        running: false,
        accessibilityPermission: false,
        screenRecordingPermission: false,
      });
      await readiness;
    });
    expect(state.ask).not.toHaveBeenCalled();
    expect(requestPermissions).not.toHaveBeenCalled();
  },
);

it("a changed prepared connection cannot display history or a cached context from the old account", async () => {
  setup();
  await using screen = await mount();
  await captureSnapshot();
  await type(composer(screen), "Account one question");
  await submit(screen);
  expect(text(screen)).toContain("Account one question");
  state.connection = {};
  await publish();
  await openEnvironment(screen);
  expect(text(screen)).not.toContain("Account one question");
  expect(text(screen)).not.toContain("Fresh environment snapshot");
  expect(sendButton(screen).disabled).toBe(true);
  await captureSnapshot();
  expect(text(screen)).toContain("Fresh environment snapshot");
});

it("without an environment still offers manual feedback", async () => {
  setup();
  state.environmentId = null;
  state.connection = null;
  await using screen = await mount();
  expect(state.contextAtom).not.toHaveBeenCalled();
  expect(sendButton(screen).disabled).toBe(true);
  await click(button(screen, "Prepare feedback"));
  expect(text(screen)).toContain("Open issue tracker");
});

it.each(["diagnostics", "orchestration", "operate"])(
  "revoking %s access removes protected UI and feedback and invalidates a pending reply",
  async (scope) => {
    setup();
    await using screen = await mount();
    await captureSnapshot();
    await openEnvironment(screen);
    await type(composer(screen), "Sensitive earlier Help question");
    await submit(screen);
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((done) => {
      resolve = done;
    });
    state.ask.mockReturnValueOnce(response);
    await type(composer(screen), "Sensitive pending question");
    await submit(screen);
    await click(button(screen, "Prepare feedback"));
    await click(includeConversation(screen));
    expect(preview(screen)).toContain("Sensitive earlier Help question");
    if (scope === "diagnostics") state.diagnostics = false;
    else if (scope === "orchestration") state.orchestration = false;
    else state.allowed = false;
    await publish();
    expect(text(screen)).not.toContain("Sensitive earlier Help question");
    expect(text(screen)).not.toContain("Sensitive pending question");
    if (scope !== "operate") {
      expect(text(screen)).not.toContain("Fresh environment snapshot");
      expect(refreshButton(screen).disabled).toBe(true);
    } else {
      expect(text(screen)).toContain("Fresh environment snapshot");
      expect(refreshButton(screen).disabled).toBe(false);
      await click(refreshButton(screen));
      await captureSnapshot();
      expect(text(screen)).toContain("Fresh environment snapshot");
    }
    expect(composer(screen).value).toBe("");
    expect(sendButton(screen).disabled).toBe(true);
    expect(preview(screen)).not.toContain("Help conversation (included by choice)");
    await act(async () => {
      resolve(AsyncResult.success({ ...answer, answer: "Late protected answer" }));
      await response;
    });
    state.diagnostics = true;
    state.orchestration = true;
    state.allowed = true;
    await publish();
    await captureSnapshot();
    expect(text(screen)).not.toContain("Sensitive earlier Help question");
    expect(text(screen)).not.toContain("Late protected answer");
    expect(text(screen)).toContain("Providers");
    expect(text(screen)).toContain("Open issue tracker");
  },
);

it.each(["diagnostics", "orchestration", "operate"])(
  "revoking %s clears feedback fields before preview, copy, and download can expose a snapshot path",
  async (scope) => {
    setup();
    const privatePath = "/custom-mount/private app/state";
    await using screen = await mount();
    state.data = { ...context, paths: [{ label: "App state", path: privatePath }] };
    state.isSuccess = true;
    await publish();
    await click(button(screen, "Prepare feedback"));
    for (const field of ["summary", "steps", "expected", "actual"]) {
      await type(feedbackField(screen, field), `Protected ${field}: ${privatePath}`);
    }
    expect(preview(screen)).toContain("[local path]");
    expect(preview(screen)).not.toContain(privatePath);
    await click(includeConversation(screen));
    if (scope === "diagnostics") state.diagnostics = false;
    else if (scope === "orchestration") state.orchestration = false;
    else state.allowed = false;
    await publish();
    for (const field of ["summary", "steps", "expected", "actual"]) {
      expect(feedbackField(screen, field).value).toBe("");
    }
    expect(includeConversation(screen).getAttribute("aria-checked")).toBe("false");
    expect(preview(screen)).not.toContain(privatePath);
    expect(preview(screen)).not.toContain("Protected");
    if (scope !== "operate") expect(preview(screen)).toContain("App context unavailable");
    await click(button(screen, "Copy report"));
    expect(state.copy).toHaveBeenLastCalledWith(preview(screen), "Help report");
    expect(state.copy.mock.calls.at(-1)?.[0]).not.toContain(privatePath);
    using createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:revoked-report");
    using _revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    // Keeps the browser from saving the report while the test reads the exact blob.
    using _download = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    await click(button(screen, "Download report"));
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await blob.text()).toBe(preview(screen));
    expect(await blob.text()).not.toContain(privatePath);
    state.diagnostics = true;
    state.orchestration = true;
    state.allowed = true;
    await publish();
    await captureSnapshot();
    expect(preview(screen)).not.toContain("Protected");
  },
);

it.each([true, false])(
  "a new authenticated connection cannot inherit feedback or cached snapshots (operate=%s)",
  async (allowed) => {
    setup();
    state.allowed = allowed;
    await using screen = await mount();
    await captureSnapshot();
    await click(button(screen, "Prepare feedback"));
    await type(
      feedbackField(screen, "summary"),
      "Previous account feedback /custom-mount/private app/state",
    );
    await click(includeConversation(screen));
    state.connection = {};
    await publish();
    await openEnvironment(screen);
    expect(text(screen)).not.toContain("Fresh environment snapshot");
    await click(button(screen, "Prepare feedback"));
    expect(feedbackField(screen, "summary").value).toBe("");
    expect(includeConversation(screen).getAttribute("aria-checked")).toBe("false");
    expect(preview(screen)).not.toContain("Previous account feedback");
  },
);

it.each([false, true])(
  "an Ask denial after Clear=%s requires a new authorized diagnostics read",
  async (clearPending) => {
    setup();
    await using screen = await mount();
    await captureSnapshot();
    await openEnvironment(screen);
    await click(button(screen, "Prepare feedback"));
    let deny!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      deny = resolve;
    });
    state.ask.mockReturnValueOnce(pending);
    await type(composer(screen), "Question rejected by the server");
    await submit(screen);
    if (clearPending) await click(button(screen, "Clear conversation"));
    await act(async () => {
      deny(
        AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              message: "private diagnostics denial",
              requiredScope: AuthDiagnosticsReadScope,
              requiredPermission: AuthDiagnosticsReadScope,
            }),
          ),
        ),
      );
      await pending;
    });
    expect(state.allowed).toBe(true);
    expect(state.diagnostics).toBe(true);
    expect(text(screen)).not.toContain("Fresh environment snapshot");
    expect(text(screen)).not.toContain("private diagnostics denial");
    expect(preview(screen)).toContain("App context unavailable");
    expect(sendButton(screen).disabled).toBe(true);
    await captureSnapshot();
    expect(text(screen)).not.toContain("Fresh environment snapshot");
    await click(refreshButton(screen));
    await captureSnapshot();
    expect(text(screen)).toContain("Fresh environment snapshot");
    expect(text(screen)).not.toContain("Question rejected by the server");
  },
);

it("an explicitly denied refresh removes cached context and conversation even when cached grants still allow Help", async () => {
  setup();
  await using screen = await mount();
  await captureSnapshot();
  await openEnvironment(screen);
  await type(composer(screen), "Protected question before denial");
  await submit(screen);
  await click(button(screen, "Prepare feedback"));
  await click(includeConversation(screen));
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((done) => {
    resolve = done;
  });
  state.ask.mockReturnValueOnce(response);
  await type(composer(screen), "Pending before denied refresh");
  await submit(screen);
  state.failure = new EnvironmentAuthorizationError({
    message: "private denied message",
    requiredScope: AuthDiagnosticsReadScope,
  });
  state.error = "private denied message";
  state.isSuccess = false;
  await publish();
  expect(state.allowed).toBe(true);
  expect(state.diagnostics).toBe(true);
  expect(text(screen)).not.toContain("Protected question before denial");
  expect(text(screen)).not.toContain("Fresh environment snapshot");
  expect(text(screen)).not.toContain("private denied message");
  expect(text(screen)).toContain("Help access was denied");
  expect(preview(screen)).toContain("App context unavailable");
  await act(async () => {
    resolve(AsyncResult.success({ ...answer, answer: "Late denied answer" }));
    await response;
  });
  state.failure = null;
  state.error = null;
  await captureSnapshot();
  expect(text(screen)).not.toContain("Protected question before denial");
  expect(text(screen)).not.toContain("Late denied answer");
});

it("a fresh snapshot cannot restore conversation access after operation permission is revoked", async () => {
  setup();
  await using screen = await mount();
  await captureSnapshot();
  await type(composer(screen), "Question before losing operation permission");
  await submit(screen);
  state.allowed = false;
  await publish();
  await captureSnapshot();
  expect(text(screen)).not.toContain("Question before losing operation permission");
  expect(composer(screen).value).toBe("");
  expect(sendButton(screen).disabled).toBe(true);
  expect(text(screen)).toContain("orchestration:operate");
});

it("checks current authorization on completion after navigating away", async () => {
  setup();
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((done) => {
    resolve = done;
  });
  state.ask.mockReturnValueOnce(response);
  await using first = await mount();
  await captureSnapshot();
  await type(composer(first), "Pending while away");
  await submit(first);
  await first.unmount();
  state.diagnostics = false;
  await act(async () => {
    resolve(AsyncResult.success({ ...answer, answer: "Denied while away" }));
    await response;
  });
  state.diagnostics = true;
  await using second = await mount();
  await captureSnapshot();
  expect(text(second)).not.toContain("Pending while away");
  expect(text(second)).not.toContain("Denied while away");
});
