import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type HelpAskResult,
  type HelpContext,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HelpPage } from "./HelpPage";

const state = vi.hoisted(() => ({
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
  copy: vi.fn(async (_report: string) => true),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: state.copy }));
vi.mock("../../hooks/useSettings", () => ({
  ensureClientSettingsHydrated: state.hydrateClientSettings,
  getClientSettings: state.getClientSettings,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.allowed }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => state.environmentId,
  useEnvironment: () =>
    state.environmentId
      ? {
          label: "Primary test host",
          connection: { phase: state.connected ? "connected" : "disconnected" },
        }
      : null,
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () => (state.connection ? Option.some(state.connection) : Option.none()),
  useEnvironmentScope: (_id: unknown, scope: string) =>
    scope === AuthDiagnosticsReadScope ? state.diagnostics : state.orchestration,
  readPreparedConnection: () => state.connection,
  readEnvironmentScope: (_id: unknown, scope: string) =>
    scope === AuthDiagnosticsReadScope
      ? state.diagnostics
      : scope === AuthOrchestrationReadScope
        ? state.orchestration
        : state.allowed,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    helpContext: state.contextAtom,
    askHelp: { permissionAtom: () => "ask-permission" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom ? state.data : null,
    isSuccess: atom ? state.isSuccess : false,
    isPending: false,
    error: atom ? state.error : null,
    failure: atom ? state.failure : null,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.ask }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "main" }));
vi.mock("../ui/collapsible", () => ({
  Collapsible: "div",
  CollapsiblePanel: "div",
  CollapsibleTrigger: "button",
}));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "nav",
  WorkspaceBreadcrumbItem: "span",
}));
vi.mock("@tanstack/react-router", () => ({ Link: "a" }));

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
let renderer: ReactTestRenderer | null = null;
const root = () => renderer!.root;
const visibleText = () =>
  JSON.stringify(renderer!.toJSON(), (key, value) => (key === "props" ? undefined : value));
const composer = () => root().findByProps({ id: "help-question" });
const submit = () => root().findByType("form").props.onSubmit({ preventDefault: vi.fn() });
const sendButton = () =>
  root().findAll((node) => node.type === "button" && node.props.type === "submit")[0]!;
const button = (label: string) =>
  root()
    .findAll((node) => node.type === "button")
    .find((node) => node.children.includes(label))!;
async function mount() {
  await act(() => {
    renderer = create(<HelpPage />);
  });
}
async function captureSnapshot() {
  state.data = { ...context };
  state.isSuccess = true;
  await act(() => renderer!.update(<HelpPage />));
}
async function draft(value: string) {
  await act(() => composer().props.onChange({ target: { value } }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

it("quick questions only fill the composer; Send produces a reply and follow-up uses it", async () => {
  await mount();
  await captureSnapshot();
  expect(visibleText()).toContain("Primary test host");
  expect(state.ask).not.toHaveBeenCalled();
  expect(state.hydrateClientSettings).not.toHaveBeenCalled();
  expect(state.getClientSettings).not.toHaveBeenCalled();
  await act(() => button("Why is my provider not responding?").props.onClick());
  expect(composer().props.value).toBe("Why is my provider not responding?");
  expect(state.ask).not.toHaveBeenCalled();
  expect(state.hydrateClientSettings).not.toHaveBeenCalled();
  await act(async () => submit());
  expect(visibleText()).toContain(answer.answer);
  expect(composer().props.value).toBe("");
  await draft("How do I reconnect?");
  await act(async () => submit());
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
  const suffix = "Finally, reconnect in Settings > Providers.";
  const fullAnswer = "x".repeat(16_000 - suffix.length) + suffix;
  state.ask.mockResolvedValue(AsyncResult.success({ ...answer, answer: fullAnswer }));
  await mount();
  await captureSnapshot();
  await draft("How do I restore the provider?");
  await act(async () => submit());
  expect(visibleText()).toContain(fullAnswer);
  await draft("What comes next?");
  await act(async () => submit());
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
  expect(visibleText()).toContain(fullAnswer);
});

it("keeps a pending request through navigation and stops duplicate submission", async () => {
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((done) => {
    resolve = done;
  });
  state.ask.mockReturnValue(response);
  await mount();
  await captureSnapshot();
  await draft("Waiting question");
  await act(() => submit());
  expect(sendButton().props.disabled).toBe(true);
  await act(() => renderer!.unmount());
  await mount();
  expect(visibleText()).toContain("Help is preparing a response");
  await act(() => submit());
  expect(state.ask).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(AsyncResult.success(answer));
    await response;
  });
  expect(visibleText()).toContain(answer.answer);
});

it("does not submit Shift+Enter or IME composition; Enter sends once", async () => {
  await mount();
  await captureSnapshot();
  await draft("Keyboard question");
  const key = (shiftKey: boolean, isComposing: boolean, keyCode = 13) => ({
    key: "Enter",
    shiftKey,
    nativeEvent: { isComposing, keyCode },
    preventDefault: vi.fn(),
  });
  await act(() => composer().props.onKeyDown(key(true, false)));
  await act(() => composer().props.onKeyDown(key(false, true)));
  await act(() => composer().props.onKeyDown(key(false, false, 229)));
  expect(state.ask).not.toHaveBeenCalled();
  await act(async () => composer().props.onKeyDown(key(false, false)));
  expect(state.ask).toHaveBeenCalledTimes(1);
});

it("keeps input and recovery after a top-level failure and retries only on request", async () => {
  state.ask.mockResolvedValueOnce(
    AsyncResult.failure(Cause.die(new Error("private transport exception"))),
  );
  await mount();
  await captureSnapshot();
  await draft("Please help reconnect");
  await act(async () => submit());
  expect(visibleText()).not.toContain("private transport exception");
  expect(composer().props.value).toBe("Please help reconnect");
  expect(visibleText()).toContain("Providers");
  expect(visibleText()).toContain("Connections");
  expect(state.ask).toHaveBeenCalledTimes(1);
  await act(async () => button("Retry response").props.onClick());
  expect(visibleText()).toContain(answer.answer);
  expect(state.ask).toHaveBeenCalledTimes(2);
});

it.each(["diagnostics", "orchestration"])(
  "denied %s read makes no snapshot request but keeps feedback and settings available",
  async (scope) => {
    if (scope === "diagnostics") state.diagnostics = false;
    else state.orchestration = false;
    await mount();
    expect(state.contextAtom).not.toHaveBeenCalled();
    expect(sendButton().props.disabled).toBe(true);
    expect(visibleText()).toContain("diagnostics:read");
    expect(visibleText()).toContain("orchestration:read");
    expect(visibleText()).toContain("Providers");
    await act(() => button("Prepare feedback").props.onClick());
    expect(root().findByProps({ id: "help-feedback-summary" })).toBeDefined();
    expect(visibleText()).toContain("Nothing is sent until you submit it in the issue tracker.");
    expect(visibleText()).toContain("App context unavailable");
  },
);

it("blocks Ask when operate scope is missing or context API fails without exposing the error", async () => {
  state.allowed = false;
  await mount();
  await captureSnapshot();
  await draft("Question");
  await act(() => submit());
  expect(state.ask).not.toHaveBeenCalled();
  expect(sendButton().props.disabled).toBe(true);
  expect(visibleText()).toContain("orchestration:operate");
  state.allowed = true;
  state.error = "unsupported method; private transport data";
  state.isSuccess = false;
  await act(() => renderer!.update(<HelpPage />));
  expect(visibleText()).not.toContain("private transport");
  expect(sendButton().props.disabled).toBe(true);
});

it("read-only users with diagnostics and orchestration access can refresh while Ask stays disabled", async () => {
  state.allowed = false;
  await mount();
  expect(state.contextAtom).toHaveBeenCalled();
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await captureSnapshot();
  expect(visibleText()).toContain("Fresh environment snapshot");
  expect(composer().props.disabled).toBe(true);
  expect(sendButton().props.disabled).toBe(true);
  expect(button("Refresh").props.disabled).toBe(false);
  await act(() => button("Refresh").props.onClick());
  expect(state.refresh).toHaveBeenCalledTimes(2);
  state.data = { ...context, environmentName: "Refreshed read-only snapshot" };
  await act(() => renderer!.update(<HelpPage />));
  expect(visibleText()).toContain("Refreshed read-only snapshot");
  expect(visibleText()).not.toContain("Fresh environment snapshot");
  await act(() => button("Prepare feedback").props.onClick());
  expect(root().findByType("pre").children.join("")).toContain("App version: 0.3.1");
  await act(() => submit());
  expect(state.ask).not.toHaveBeenCalled();
});

it("Refresh rechecks current read permissions and the prepared connection before requesting", async () => {
  await mount();
  await captureSnapshot();
  state.refresh.mockClear();
  state.diagnostics = false;
  await act(() => button("Refresh").props.onClick());
  expect(state.refresh).not.toHaveBeenCalled();
  state.diagnostics = true;
  state.orchestration = false;
  await act(() => button("Refresh").props.onClick());
  expect(state.refresh).not.toHaveBeenCalled();
  state.orchestration = true;
  state.connection = {};
  await act(() => button("Refresh").props.onClick());
  expect(state.refresh).not.toHaveBeenCalled();
});

it("reads fresh preferences on each actual send and retry without inferring on open", async () => {
  state.ask.mockResolvedValueOnce(AsyncResult.failure(Cause.die(new Error("private failure"))));
  await mount();
  await captureSnapshot();
  expect(state.hydrateClientSettings).not.toHaveBeenCalled();
  state.clientSettings = { ...DEFAULT_CLIENT_SETTINGS, composerRichTextEnabled: false };
  await draft("Why is the composer plain text?");
  await act(async () => submit());
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
  await act(async () => button("Retry response").props.onClick());
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
  const readiness = {
    enabled: true,
    available: true,
    running: false,
    accessibilityPermission: false,
    screenRecordingPermission: null as boolean | null,
  };
  const getComputerUseState = vi.fn(async () => ({ ...readiness }));
  const mutate = vi.fn();
  vi.stubGlobal("window", {
    desktopBridge: {
      getClientPlatform: () => "win32",
      getComputerUseState,
      setComputerUseEnabled: mutate,
      requestSystemPermission: mutate,
    },
  });
  await mount();
  state.data = { ...context, mode: "server", platform: "linux" };
  state.isSuccess = true;
  await act(() => renderer!.update(<HelpPage />));
  expect(getComputerUseState).not.toHaveBeenCalled();
  await draft("Can this desktop control my screen?");
  await act(async () => submit());
  expect(state.ask.mock.calls[0]?.[0]).toMatchObject({
    input: {
      client: {
        surface: "desktop",
        platform: "win32",
        computerUse: { ...readiness },
      },
    },
  });
  readiness.accessibilityPermission = true;
  readiness.screenRecordingPermission = true;
  await draft("Are the permissions ready now?");
  await act(async () => submit());
  expect(state.ask.mock.calls[1]?.[0]).toMatchObject({
    input: {
      client: {
        surface: "desktop",
        platform: "win32",
        computerUse: { ...readiness },
      },
    },
  });
  expect(getComputerUseState).toHaveBeenCalledTimes(2);
  expect(mutate).not.toHaveBeenCalled();
});

it.each(["clear", "new connection", "diagnostics", "orchestration", "operate"])(
  "a late hydration read after %s cannot start inference",
  async (change) => {
    let finish!: () => void;
    const hydration = new Promise<void>((resolve) => {
      finish = resolve;
    });
    state.hydrateClientSettings.mockReturnValueOnce(hydration);
    await mount();
    await captureSnapshot();
    await draft("Question awaiting local preferences");
    await act(() => submit());
    expect(state.ask).not.toHaveBeenCalled();
    if (change === "clear") {
      // A pending read survives navigation; Clear in the new mount must still cancel it.
      await act(() => renderer!.unmount());
      await mount();
      await act(() => button("Clear conversation").props.onClick());
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
  let finishOld!: () => void;
  const oldHydration = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  state.hydrateClientSettings.mockReturnValueOnce(oldHydration);
  await mount();
  await captureSnapshot();
  await draft("Same question");
  await act(() => submit());
  await act(() => button("Clear conversation").props.onClick());
  await draft("Same question");
  await act(async () => submit());
  expect(state.ask).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishOld();
    await oldHydration;
  });
  expect(state.ask).toHaveBeenCalledTimes(1);
  expect(visibleText()).toContain(answer.answer);
});

it("a local read keeps its actual send through navigation when the connection and access remain current", async () => {
  let finish!: () => void;
  const hydration = new Promise<void>((resolve) => {
    finish = resolve;
  });
  state.hydrateClientSettings.mockReturnValueOnce(hydration);
  await mount();
  await captureSnapshot();
  await draft("Question pending across navigation");
  await act(() => submit());
  await act(() => renderer!.unmount());
  await mount();
  expect(visibleText()).toContain("Help is preparing a response");
  expect(state.ask).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await hydration;
  });
  expect(state.ask).toHaveBeenCalledTimes(1);
  expect(visibleText()).toContain(answer.answer);
});

it.each(["clear", "orchestration"])(
  "a late desktop readiness read after %s cannot start inference or request permissions",
  async (change) => {
    let finish!: (value: unknown) => void;
    const readiness = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const getComputerUseState = vi.fn(() => readiness);
    const requestPermissions = vi.fn();
    vi.stubGlobal("window", {
      desktopBridge: {
        getComputerUseState,
        requestSystemPermission: requestPermissions,
        setComputerUseEnabled: requestPermissions,
      },
    });
    await mount();
    await captureSnapshot();
    await draft("Desktop permission question");
    await act(() => submit());
    expect(getComputerUseState).toHaveBeenCalledTimes(1);
    if (change === "clear") await act(() => button("Clear conversation").props.onClick());
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
  await mount();
  await captureSnapshot();
  await draft("Account one question");
  await act(async () => submit());
  expect(visibleText()).toContain("Account one question");
  state.connection = {};
  await act(() => renderer!.update(<HelpPage />));
  expect(visibleText()).not.toContain("Account one question");
  expect(visibleText()).not.toContain("Fresh environment snapshot");
  expect(sendButton().props.disabled).toBe(true);
  await captureSnapshot();
  expect(visibleText()).toContain("Fresh environment snapshot");
});

it("without an environment still offers manual feedback", async () => {
  state.environmentId = null;
  state.connection = null;
  await mount();
  expect(state.contextAtom).not.toHaveBeenCalled();
  expect(sendButton().props.disabled).toBe(true);
  await act(() => button("Prepare feedback").props.onClick());
  expect(visibleText()).toContain("Open issue tracker");
});

it.each(["diagnostics", "orchestration", "operate"])(
  "revoking %s access removes protected UI and feedback and invalidates a pending reply",
  async (scope) => {
    await mount();
    await captureSnapshot();
    await draft("Sensitive earlier Help question");
    await act(async () => submit());
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((done) => {
      resolve = done;
    });
    state.ask.mockReturnValueOnce(response);
    await draft("Sensitive pending question");
    await act(() => submit());
    await act(() => button("Prepare feedback").props.onClick());
    await act(() =>
      root().findByProps({ id: "help-feedback-conversation" }).props.onCheckedChange(true),
    );
    expect(root().findByType("pre").children.join("")).toContain("Sensitive earlier Help question");
    if (scope === "diagnostics") state.diagnostics = false;
    else if (scope === "orchestration") state.orchestration = false;
    else state.allowed = false;
    await act(() => renderer!.update(<HelpPage />));
    expect(visibleText()).not.toContain("Sensitive earlier Help question");
    expect(visibleText()).not.toContain("Sensitive pending question");
    if (scope !== "operate") {
      expect(visibleText()).not.toContain("Fresh environment snapshot");
      expect(button("Refresh").props.disabled).toBe(true);
    } else {
      expect(visibleText()).toContain("Fresh environment snapshot");
      expect(button("Refresh").props.disabled).toBe(false);
      await act(() => button("Refresh").props.onClick());
      await captureSnapshot();
      expect(visibleText()).toContain("Fresh environment snapshot");
    }
    expect(composer().props.value).toBe("");
    expect(sendButton().props.disabled).toBe(true);
    expect(root().findByType("pre").children.join("")).not.toContain(
      "Help conversation (included by choice)",
    );
    await act(async () => {
      resolve(AsyncResult.success({ ...answer, answer: "Late protected answer" }));
      await response;
    });
    state.diagnostics = true;
    state.orchestration = true;
    state.allowed = true;
    await act(() => renderer!.update(<HelpPage />));
    await captureSnapshot();
    expect(visibleText()).not.toContain("Sensitive earlier Help question");
    expect(visibleText()).not.toContain("Late protected answer");
    expect(visibleText()).toContain("Providers");
    expect(visibleText()).toContain("Open issue tracker");
  },
);

it.each(["diagnostics", "orchestration", "operate"])(
  "revoking %s clears feedback fields before preview, copy, and download can expose a snapshot path",
  async (scope) => {
    const privatePath = "/custom-mount/private app/state";
    await mount();
    state.data = { ...context, paths: [{ label: "App state", path: privatePath }] };
    state.isSuccess = true;
    await act(() => renderer!.update(<HelpPage />));
    await act(() => button("Prepare feedback").props.onClick());
    for (const field of ["summary", "steps", "expected", "actual"]) {
      await act(() =>
        root()
          .findByProps({ id: `help-feedback-${field}` })
          .props.onChange({ target: { value: `Protected ${field}: ${privatePath}` } }),
      );
    }
    const preview = () => root().findByType("pre").children.join("");
    expect(preview()).toContain("[local path]");
    expect(preview()).not.toContain(privatePath);
    await act(() =>
      root().findByProps({ id: "help-feedback-conversation" }).props.onCheckedChange(true),
    );
    if (scope === "diagnostics") state.diagnostics = false;
    else if (scope === "orchestration") state.orchestration = false;
    else state.allowed = false;
    await act(() => renderer!.update(<HelpPage />));
    for (const field of ["summary", "steps", "expected", "actual"])
      expect(root().findByProps({ id: `help-feedback-${field}` }).props.value).toBe("");
    expect(root().findByProps({ id: "help-feedback-conversation" }).props.checked).toBe(false);
    expect(preview()).not.toContain(privatePath);
    expect(preview()).not.toContain("Protected");
    if (scope !== "operate") expect(preview()).toContain("App context unavailable");
    await act(async () => button("Copy report").props.onClick());
    expect(state.copy).toHaveBeenLastCalledWith(preview(), "Help report");
    expect(state.copy.mock.calls.at(-1)?.[0]).not.toContain(privatePath);
    const createObjectURL = vi.fn((_blob: Blob) => "blob:revoked-report");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    vi.stubGlobal("document", {
      createElement: () => ({ click: vi.fn(), remove: vi.fn() }),
      body: { appendChild: vi.fn() },
    });
    await act(() => button("Download report").props.onClick());
    expect(await createObjectURL.mock.calls[0]?.[0].text()).toBe(preview());
    expect(await createObjectURL.mock.calls[0]?.[0].text()).not.toContain(privatePath);
    state.diagnostics = true;
    state.orchestration = true;
    state.allowed = true;
    await act(() => renderer!.update(<HelpPage />));
    await captureSnapshot();
    expect(preview()).not.toContain("Protected");
  },
);

it.each([true, false])(
  "a new authenticated connection cannot inherit feedback or cached snapshots (operate=%s)",
  async (allowed) => {
    state.allowed = allowed;
    await mount();
    await captureSnapshot();
    await act(() => button("Prepare feedback").props.onClick());
    await act(() =>
      root()
        .findByProps({ id: "help-feedback-summary" })
        .props.onChange({
          target: { value: "Previous account feedback /custom-mount/private app/state" },
        }),
    );
    await act(() =>
      root().findByProps({ id: "help-feedback-conversation" }).props.onCheckedChange(true),
    );
    state.connection = {};
    await act(() => renderer!.update(<HelpPage />));
    expect(visibleText()).not.toContain("Fresh environment snapshot");
    await act(() => button("Prepare feedback").props.onClick());
    expect(root().findByProps({ id: "help-feedback-summary" }).props.value).toBe("");
    expect(root().findByProps({ id: "help-feedback-conversation" }).props.checked).toBe(false);
    expect(root().findByType("pre").children.join("")).not.toContain("Previous account feedback");
  },
);

it.each([false, true])(
  "an Ask denial after Clear=%s requires a new authorized diagnostics read",
  async (clearPending) => {
    await mount();
    await captureSnapshot();
    await act(() => button("Prepare feedback").props.onClick());
    let deny!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      deny = resolve;
    });
    state.ask.mockReturnValueOnce(pending);
    await draft("Question rejected by the server");
    await act(() => submit());
    if (clearPending) await act(() => button("Clear conversation").props.onClick());
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
    expect(visibleText()).not.toContain("Fresh environment snapshot");
    expect(visibleText()).not.toContain("private diagnostics denial");
    expect(root().findByType("pre").children.join("")).toContain("App context unavailable");
    expect(sendButton().props.disabled).toBe(true);
    await captureSnapshot();
    expect(visibleText()).not.toContain("Fresh environment snapshot");
    await act(() => button("Refresh").props.onClick());
    await captureSnapshot();
    expect(visibleText()).toContain("Fresh environment snapshot");
    expect(visibleText()).not.toContain("Question rejected by the server");
  },
);

it("an explicitly denied refresh removes cached context and conversation even when cached grants still allow Help", async () => {
  await mount();
  await captureSnapshot();
  await draft("Protected question before denial");
  await act(async () => submit());
  await act(() => button("Prepare feedback").props.onClick());
  await act(() =>
    root().findByProps({ id: "help-feedback-conversation" }).props.onCheckedChange(true),
  );
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((done) => {
    resolve = done;
  });
  state.ask.mockReturnValueOnce(response);
  await draft("Pending before denied refresh");
  await act(() => submit());
  state.failure = new EnvironmentAuthorizationError({
    message: "private denied message",
    requiredScope: AuthDiagnosticsReadScope,
  });
  state.error = "private denied message";
  state.isSuccess = false;
  await act(() => renderer!.update(<HelpPage />));
  expect(state.allowed).toBe(true);
  expect(state.diagnostics).toBe(true);
  expect(visibleText()).not.toContain("Protected question before denial");
  expect(visibleText()).not.toContain("Fresh environment snapshot");
  expect(visibleText()).not.toContain("private denied message");
  expect(visibleText()).toContain("Help access was denied");
  expect(root().findByType("pre").children.join("")).toContain("App context unavailable");
  await act(async () => {
    resolve(AsyncResult.success({ ...answer, answer: "Late denied answer" }));
    await response;
  });
  state.failure = null;
  state.error = null;
  await captureSnapshot();
  expect(visibleText()).not.toContain("Protected question before denial");
  expect(visibleText()).not.toContain("Late denied answer");
});

it("a fresh snapshot cannot restore conversation access after operation permission is revoked", async () => {
  await mount();
  await captureSnapshot();
  await draft("Question before losing operation permission");
  await act(async () => submit());
  state.allowed = false;
  await act(() => renderer!.update(<HelpPage />));
  await captureSnapshot();
  expect(visibleText()).not.toContain("Question before losing operation permission");
  expect(composer().props.value).toBe("");
  expect(sendButton().props.disabled).toBe(true);
  expect(visibleText()).toContain("orchestration:operate");
});

it("checks current authorization on completion after navigating away", async () => {
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((done) => {
    resolve = done;
  });
  state.ask.mockReturnValueOnce(response);
  await mount();
  await captureSnapshot();
  await draft("Pending while away");
  await act(() => submit());
  await act(() => renderer!.unmount());
  state.diagnostics = false;
  await act(async () => {
    resolve(AsyncResult.success({ ...answer, answer: "Denied while away" }));
    await response;
  });
  state.diagnostics = true;
  await mount();
  await captureSnapshot();
  expect(visibleText()).not.toContain("Pending while away");
  expect(visibleText()).not.toContain("Denied while away");
});
