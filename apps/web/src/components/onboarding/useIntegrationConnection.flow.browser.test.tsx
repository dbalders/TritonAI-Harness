import { act, render as renderUi, fakeTimers, type Screen } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { useIntegrationConnection, type IntegrationConnection } from "./useIntegrationConnection";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  connect: vi.fn(),
  poll: vi.fn(),
  other: vi.fn(),
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    listIntegrations: "list",
    installIntegration: "install",
    setIntegrationEnabled: "enable",
    connectIntegration: "connect",
    pollIntegration: "poll",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "list"
      ? mocks.list
      : command === "connect"
        ? mocks.connect
        : command === "poll"
          ? mocks.poll
          : mocks.other,
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: async () => {} } }),
}));
vi.mock("../settings/PluginsSettings", () => ({ integrationNeedsConnectionAction: () => false }));

const outlook = (connectionState: "not_connected" | "connected") => ({
  id: "microsoft-365",
  installed: true,
  enabled: true,
  requiresConnection: true,
  connectionState,
  accountLabel: null,
  capabilities: [],
  tools: [],
});

describe("useIntegrationConnection", () => {
  it("lets someone try again after the plugin list couldn't be read", async () => {
    await using _fixture = await setupTest();

    mocks.list.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
    await _fixture.render("local");
    expect(_fixture.latest?.status).toBe("failed");
    expect(_fixture.latest?.error).toContain("Try again");

    await act(async () => {
      await _fixture.latest?.connect();
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(_fixture.latest?.status).toBe("ready");
  });

  it("picks a sign-in back up after switching to another environment and back", async () => {
    await using _fixture = await setupTest();

    await _fixture.render("local");
    expect(_fixture.latest?.status).toBe("ready");
    await act(async () => {
      await _fixture.latest?.connect();
    });
    expect(_fixture.latest?.status).toBe("waiting");

    await _fixture.render("remote");
    expect(_fixture.latest?.status).toBe("ready");
    expect(_fixture.latest?.flow).toBeNull();

    await _fixture.render("local");
    expect(_fixture.latest?.status).toBe("waiting");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.poll).toHaveBeenCalledWith({
      environmentId: "local",
      input: { id: "microsoft-365", flowId: "flow-1" },
    });
    expect(_fixture.latest?.status).toBe("connected");
  });

  it("keeps a finished sign-in when an older plugin list answers after it", async () => {
    await using _fixture = await setupTest();

    await _fixture.render("local");
    await act(async () => {
      await _fixture.latest?.connect();
    });
    await _fixture.render("remote");

    // Coming back starts a fresh list that is slower than the resumed sign-in check.
    let answerList: (value: unknown) => void = () => {};
    mocks.list.mockReturnValueOnce(new Promise((resolve) => (answerList = resolve)));
    await _fixture.render("local");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(_fixture.latest?.status).toBe("connected");

    await act(async () =>
      answerList({ _tag: "Success", value: { integrations: [outlook("not_connected")] } }),
    );
    expect(_fixture.latest?.status).toBe("connected");
  });

  it("keeps a finished sign-in when an earlier attempt's poll answers late", async () => {
    await using _fixture = await setupTest();

    let answerFirstPoll: (value: unknown) => void = () => {};
    mocks.poll.mockReturnValueOnce(new Promise((resolve) => (answerFirstPoll = resolve)));
    await _fixture.render("local");
    await act(async () => {
      await _fixture.latest?.connect();
    });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    // Start over, and the new sign-in completes.
    mocks.connect.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        kind: "device_code",
        flowId: "flow-2",
        verificationUri: "https://microsoft.com/devicelogin",
        verificationUriComplete: null,
        userCode: "WXYZ-9876",
        message: "Enter the code",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        intervalSeconds: 5,
      },
    });
    await act(async () => {
      await _fixture.latest?.connect();
    });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(_fixture.latest?.status).toBe("connected");

    await act(async () =>
      answerFirstPoll({
        _tag: "Success",
        value: {
          state: "failed",
          retryAfterSeconds: null,
          message: "The old code expired.",
          integration: outlook("not_connected"),
        },
      }),
    );
    expect(_fixture.latest?.status).toBe("connected");
    expect(_fixture.latest?.integration?.connectionState).toBe("connected");
  });

  it("ignores a late answer for a sign-in that Start over replaced", async () => {
    await using _fixture = await setupTest();

    let answerFirstPoll: (value: unknown) => void = () => {};
    mocks.poll.mockReturnValueOnce(new Promise((resolve) => (answerFirstPoll = resolve)));
    await _fixture.render("local");
    await act(async () => {
      await _fixture.latest?.connect();
    });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.poll).toHaveBeenCalledTimes(1);

    mocks.connect.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        kind: "device_code",
        flowId: "flow-2",
        verificationUri: "https://microsoft.com/devicelogin",
        verificationUriComplete: null,
        userCode: "WXYZ-9876",
        message: "Enter the code",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        intervalSeconds: 5,
      },
    });
    await act(async () => {
      await _fixture.latest?.connect();
    });
    await act(async () =>
      answerFirstPoll({
        _tag: "Success",
        value: {
          state: "failed",
          retryAfterSeconds: null,
          message: "The old code expired.",
          integration: outlook("not_connected"),
        },
      }),
    );

    expect(_fixture.latest?.status).toBe("waiting");
    expect(
      _fixture.latest?.flow?.kind === "device_code" ? _fixture.latest.flow.userCode : null,
    ).toBe("WXYZ-9876");
    expect(_fixture.latest?.error).toBeNull();
  });
});

async function setupTest() {
  const stack = new AsyncDisposableStack();
  let latest: IntegrationConnection | null = null;
  function Probe({ environmentId }: { readonly environmentId: EnvironmentId }) {
    const connection = useIntegrationConnection("microsoft-365", environmentId);
    useEffect(() => {
      latest = connection;
    });
    return null;
  }

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
  const render = async (environmentId: string) => {
    await act(async () =>
      renderSubject(<Probe environmentId={EnvironmentId.make(environmentId)} />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
  };

  screen = undefined;
  stack.use(fakeTimers());
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({
    _tag: "Success",
    value: { integrations: [outlook("not_connected")] },
  });
  mocks.connect.mockResolvedValue({
    _tag: "Success",
    value: {
      kind: "device_code",
      flowId: "flow-1",
      verificationUri: "https://microsoft.com/devicelogin",
      verificationUriComplete: null,
      userCode: "ABCD-1234",
      message: "Enter the code",
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      intervalSeconds: 5,
    },
  });
  mocks.poll.mockResolvedValue({
    _tag: "Success",
    value: {
      state: "connected",
      retryAfterSeconds: null,
      message: null,
      integration: outlook("connected"),
    },
  });

  stack.defer(async () => {
    vi.useRealTimers();
  });
  return {
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
    stack,
    get latest() {
      return latest;
    },
    set latest(value: typeof latest) {
      latest = value;
    },
    Probe,
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
    render,
  };
}
