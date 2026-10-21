import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ServerMemoryStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemorySettingsSection } from "./MemorySettings";

const state = vi.hoisted(() => ({
  environments: [] as {
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
    serverConfig: { settings: typeof DEFAULT_SERVER_SETTINGS; availableEditors: string[] } | null;
  }[],
  statuses: new Map<
    EnvironmentId,
    Atom.Writable<AsyncResult.AsyncResult<ServerMemoryStatus, Error>>
  >(),
  writable: new Set<EnvironmentId>(),
  commands: new Map<string, ReturnType<typeof vi.fn>>(),
  update: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    memoryStatus: ({ environmentId }: { environmentId: EnvironmentId }) =>
      state.statuses.get(environmentId)!,
    startMemorySync: "start",
    stopMemorySync: "stop",
    syncMemoryNow: "sync",
    signOutMemorySync: "sign-out",
    pollMemorySync: "poll",
  },
}));
vi.mock("../../state/shell", () => ({ shellEnvironment: { openInEditor: "open" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (key: string) => state.commands.get(key),
}));
vi.mock("../../state/session", () => ({ useEnvironmentsWithScope: () => state.writable }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: {
      kind: "all",
      environmentIds: state.environments.map((environment) => environment.environmentId),
    },
    environment: state.environments[0],
    environments: state.environments,
    connectedEnvironments: state.environments.filter(
      (environment) => environment.connection.phase === "connected",
    ),
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useUpdateScopedSettings: () => state.update,
  useScopedSettings: () => state.environments[0]?.serverConfig?.settings,
  useScopedSettingsMixed: (keys: (keyof typeof DEFAULT_SERVER_SETTINGS)[]) => {
    const connected = state.environments.filter(
      (environment) => environment.connection.phase === "connected",
    );
    return connected.some((environment) =>
      keys.some(
        (key) =>
          environment.serverConfig?.settings[key] !== connected[0]?.serverConfig?.settings[key],
      ),
    );
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
  }: {
    title: string;
    description: string;
    status: ReactNode;
    control: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {status}
      {control}
      {children}
    </div>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children,
  }: {
    value: string;
    disabled: boolean;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ children }: { children: ReactNode }) => <option>{children}</option>,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("./PluginsSettings", () => ({
  DeviceCodePrompt: ({ title, userCode }: { title: string; userCode: string }) => (
    <div role="status">
      {title}: {userCode}
    </div>
  ),
}));

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const offline = EnvironmentId.make("offline");
let registry: AtomRegistry.AtomRegistry;
let renderer: ReactTestRenderer;
function status(): ServerMemoryStatus {
  return {
    enabled: true,
    state: "idle",
    directoryPath: "/memory",
    generalDirectoryPath: "/memory/general",
    lastSummarizedDay: null,
    message: null,
    sync: {
      state: "off",
      signedIn: false,
      account: null,
      cloudFolder: "OneDrive/memory",
      lastSyncedAt: null,
      message: null,
    },
  };
}
function flow(id: EnvironmentId) {
  return AsyncResult.success({
    kind: "device_code",
    flowId: `flow-${id}`,
    userCode: `CODE-${id}`,
    verificationUri: "https://microsoft.com/devicelogin",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    intervalSeconds: 1,
  });
}
async function render() {
  await act(() => {
    renderer = create(
      <RegistryContext.Provider value={registry}>
        <MemorySettingsSection />
      </RegistryContext.Provider>,
    );
  });
}
function text() {
  return JSON.stringify(renderer.toJSON());
}
function button(label: string) {
  return renderer.root
    .findAllByType("button")
    .find((node) => node.children.filter((child) => typeof child === "string").join("") === label)!;
}
async function choose(index: number, value: string) {
  await act(() =>
    renderer.root.findAllByType("select")[index]!.props.onChange({ target: { value } }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  state.environments = [local, remote, offline].map((environmentId) => ({
    environmentId,
    label:
      environmentId === remote ? "Work PC" : environmentId === local ? "MacBook" : "Offline Mac",
    connection: { phase: environmentId === offline ? "disconnected" : "connected" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        memoryEnabled: environmentId !== remote,
        memorySyncEnabled: false,
      },
      availableEditors: ["file-manager"],
    },
  }));
  state.writable = new Set([local, remote]);
  state.statuses = new Map(
    [local, remote].map((id) => [
      id,
      Atom.make<AsyncResult.AsyncResult<ServerMemoryStatus, Error>>(AsyncResult.success(status())),
    ]),
  );
  state.commands = new Map(
    ["start", "stop", "sync", "sign-out", "poll", "open"].map((key) => [
      key,
      vi.fn().mockResolvedValue(AsyncResult.success({ kind: "connected" })),
    ]),
  );
  state.update.mockReset();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  registry.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Memory across environments", () => {
  it("keeps bulk controls visible, exposes mixed values and identifies offline computers", async () => {
    await render();
    expect(renderer.root.findAllByType("select")).toHaveLength(2);
    expect(text()).toContain("Mixed");
    expect(text()).toContain("Offline Mac");
    expect(text()).toContain("Reconnect to apply changes");
    await choose(0, "on");
    expect(state.update).toHaveBeenCalledWith({ memoryEnabled: true });
    await choose(0, "off");
    expect(state.update).toHaveBeenLastCalledWith({ memoryEnabled: false });
  });
  it("starts and stops each connected environment independently and shows partial failures", async () => {
    state.commands
      .get("start")!
      .mockImplementation(async ({ environmentId }) =>
        environmentId === remote
          ? AsyncResult.failure(Cause.fail(new Error("Work PC could not connect")))
          : AsyncResult.success({ kind: "connected" }),
      );
    await render();
    await choose(1, "on");
    expect(
      state.commands.get("start")!.mock.calls.map(([request]) => request.environmentId),
    ).toEqual([local, remote]);
    expect(text()).toContain("Work PC could not connect");
    await choose(1, "off");
    expect(
      state.commands.get("stop")!.mock.calls.map(([request]) => request.environmentId),
    ).toEqual([local, remote]);
  });
  it("keeps separate remote codes and polls while details are collapsed; cancellation stops only its flow", async () => {
    state.commands
      .get("start")!
      .mockImplementation(async ({ environmentId }) => flow(environmentId));
    state.commands
      .get("poll")!
      .mockResolvedValue(
        AsyncResult.success({ state: "pending", retryAfterSeconds: 2, message: null }),
      );
    await render();
    await choose(1, "on");
    expect(text()).toContain("Connect OneDrive on Work PC");
    expect(text()).toContain("CODE-remote");
    await act(() => button("Manage environments ").props.onClick());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(state.commands.get("poll")!.mock.calls.map(([request]) => request)).toEqual([
      { environmentId: local, input: { flowId: "flow-local" } },
      { environmentId: remote, input: { flowId: "flow-remote" } },
    ]);
    await act(() =>
      renderer.root
        .findAllByType("button")
        .filter((node) => node.children.includes("Cancel sign-in"))[1]!
        .props.onClick(),
    );
    state.commands.get("poll")!.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(
      state.commands.get("poll")!.mock.calls.map(([request]) => request.environmentId),
    ).toEqual([local]);
  });
  it("shows expired sign-ins with a retry action and honors Microsoft's polling interval", async () => {
    state.commands
      .get("start")!
      .mockImplementation(async ({ environmentId }) => flow(environmentId));
    state.commands
      .get("poll")!
      .mockResolvedValue(
        AsyncResult.success({ state: "pending", retryAfterSeconds: 2, message: null }),
      );
    await render();
    await choose(1, "on");
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(state.commands.get("poll")).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(state.commands.get("poll")).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(text()).toContain("The sign-in code expired");
    expect(button("Sign in")).toBeDefined();
  });
  it("retains Microsoft's increased interval when later pending replies omit it", async () => {
    state.commands
      .get("start")!
      .mockImplementation(async ({ environmentId }) => flow(environmentId));
    state.commands
      .get("poll")!
      .mockResolvedValue(
        AsyncResult.success({ state: "pending", retryAfterSeconds: null, message: null }),
      )
      .mockResolvedValueOnce(
        AsyncResult.success({ state: "pending", retryAfterSeconds: 2, message: null }),
      )
      .mockResolvedValueOnce(
        AsyncResult.success({ state: "pending", retryAfterSeconds: 2, message: null }),
      );
    await render();
    await choose(1, "on");
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(state.commands.get("poll")).toHaveBeenCalledTimes(4);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(state.commands.get("poll")).toHaveBeenCalledTimes(4);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(state.commands.get("poll")).toHaveBeenCalledTimes(6);
  });

  it("disables bulk changes when a connected computer is read-only", async () => {
    state.writable.delete(remote);
    await render();
    expect(renderer.root.findAllByType("select").every((node) => node.props.disabled)).toBe(true);
    await act(() => button("Manage environments ").props.onClick());
    expect(text()).toContain("This connection cannot change settings");
  });

  it("reports unavailable sync and skips it without blocking another computer", async () => {
    state.statuses.set(
      remote,
      Atom.make<AsyncResult.AsyncResult<ServerMemoryStatus, Error>>(
        AsyncResult.success({
          ...status(),
          sync: { ...status().sync, state: "unavailable" as const },
        }),
      ),
    );
    await render();
    await choose(1, "on");
    expect(
      state.commands.get("start")!.mock.calls.map(([request]) => request.environmentId),
    ).toEqual([local]);
    expect(text()).toContain("1 unavailable");
  });

  it("does not poll an environment after it disconnects", async () => {
    state.commands
      .get("start")!
      .mockImplementation(async ({ environmentId }) => flow(environmentId));
    await render();
    await choose(1, "on");
    state.environments = state.environments.map((environment) =>
      environment.environmentId === remote
        ? { ...environment, connection: { phase: "disconnected" } }
        : environment,
    );
    await act(() =>
      renderer.update(
        <RegistryContext.Provider value={registry}>
          <MemorySettingsSection />
        </RegistryContext.Provider>,
      ),
    );
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(
      state.commands.get("poll")!.mock.calls.map(([request]) => request.environmentId),
    ).toEqual([local]);
  });
});
