// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

let latest: IntegrationConnection | null = null;
function Probe({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const connection = useIntegrationConnection("microsoft-365", environmentId);
  useEffect(() => {
    latest = connection;
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;
const render = async (environmentId: string) => {
  await act(async () => root.render(<Probe environmentId={EnvironmentId.make(environmentId)} />));
  await act(async () => vi.advanceTimersByTimeAsync(0));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("useIntegrationConnection", () => {
  it("lets someone try again after the plugin list couldn't be read", async () => {
    mocks.list.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") });
    await render("local");
    expect(latest?.status).toBe("failed");
    expect(latest?.error).toContain("Try again");

    await act(async () => {
      await latest?.connect();
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(latest?.status).toBe("ready");
  });

  it("picks a sign-in back up after switching to another environment and back", async () => {
    await render("local");
    expect(latest?.status).toBe("ready");
    await act(async () => {
      await latest?.connect();
    });
    expect(latest?.status).toBe("waiting");

    await render("remote");
    expect(latest?.status).toBe("ready");
    expect(latest?.flow).toBeNull();

    await render("local");
    expect(latest?.status).toBe("waiting");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.poll).toHaveBeenCalledWith({
      environmentId: "local",
      input: { id: "microsoft-365", flowId: "flow-1" },
    });
    expect(latest?.status).toBe("connected");
  });

  it("keeps a finished sign-in when an older plugin list answers after it", async () => {
    await render("local");
    await act(async () => {
      await latest?.connect();
    });
    await render("remote");

    // Coming back starts a fresh list that is slower than the resumed sign-in check.
    let answerList: (value: unknown) => void = () => {};
    mocks.list.mockReturnValueOnce(new Promise((resolve) => (answerList = resolve)));
    await render("local");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(latest?.status).toBe("connected");

    await act(async () =>
      answerList({ _tag: "Success", value: { integrations: [outlook("not_connected")] } }),
    );
    expect(latest?.status).toBe("connected");
  });

  it("keeps a finished sign-in when an earlier attempt's poll answers late", async () => {
    let answerFirstPoll: (value: unknown) => void = () => {};
    mocks.poll.mockReturnValueOnce(new Promise((resolve) => (answerFirstPoll = resolve)));
    await render("local");
    await act(async () => {
      await latest?.connect();
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
      await latest?.connect();
    });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(latest?.status).toBe("connected");

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
    expect(latest?.status).toBe("connected");
    expect(latest?.integration?.connectionState).toBe("connected");
  });

  it("ignores a late answer for a sign-in that Start over replaced", async () => {
    let answerFirstPoll: (value: unknown) => void = () => {};
    mocks.poll.mockReturnValueOnce(new Promise((resolve) => (answerFirstPoll = resolve)));
    await render("local");
    await act(async () => {
      await latest?.connect();
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
      await latest?.connect();
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

    expect(latest?.status).toBe("waiting");
    expect(latest?.flow?.kind === "device_code" ? latest.flow.userCode : null).toBe("WXYZ-9876");
    expect(latest?.error).toBeNull();
  });
});
