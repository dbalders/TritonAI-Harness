import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type DesktopTritonAiCredentialsUpdateResult,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useTritonAiCredentialUpdate } from "./TritonAiCredentialUpdateContext";
import { settingsContentScopeKey } from "./settingsContentScopeKey";
import { resolveSettingsScope } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";
import { selectScopedSettingsEnvironments } from "./scopedSettings";

vi.mock("../../state/environments", () => ({ usePrimaryEnvironment: () => null }));

const localId = EnvironmentId.make("local");
const remoteId = EnvironmentId.make("remote");
const saved: DesktopTritonAiCredentialsUpdateResult = {
  status: "saved",
  credentials: {
    ready: true,
    usesSharedKey: true,
    onPremConfigured: true,
    frontierConfigured: true,
    onPremKeyLastFour: "1234",
    frontierKeyLastFour: "1234",
  },
};
let renderer: ReactTestRenderer | undefined;
let current: ReturnType<typeof useTritonAiCredentialUpdate>;

function CredentialOwner({
  connected,
  update,
}: {
  connected: boolean;
  update: Parameters<typeof useTritonAiCredentialUpdate>[0];
}) {
  const value = useTritonAiCredentialUpdate(update, connected);
  useLayoutEffect(() => {
    current = value;
  });
  return <p>{value.phase}</p>;
}

function SettingsLayout({
  connected,
  machine = localId,
  update,
}: {
  connected: boolean;
  machine?: EnvironmentId;
  update: Parameters<typeof useTritonAiCredentialUpdate>[0];
}) {
  const environments = [localId, remoteId].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: connected ? ("connected" as const) : ("reconnecting" as const) },
    serverConfig: connected ? { settings: DEFAULT_SERVER_SETTINGS } : null,
  }));
  const rawSearch = machine === localId ? {} : { machine };
  const search = selectSingleEnvironmentScope(
    rawSearch,
    resolveSettingsScope(rawSearch, [], environments),
    environments,
    localId,
  );
  const selected = selectScopedSettingsEnvironments(
    resolveSettingsScope(search, [], environments),
    environments,
    localId,
  );
  return (
    <div
      key={settingsContentScopeKey(
        "/settings/providers",
        search,
        selected.environment?.environmentId,
      )}
    >
      <CredentialOwner connected={connected} update={update} />
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("provider settings restart ownership", () => {
  it("retains key-update progress when the connected representative disappears", async () => {
    let finish!: (result: DesktopTritonAiCredentialsUpdateResult) => void;
    const response = new Promise<DesktopTritonAiCredentialsUpdateResult>((resolve) => {
      finish = resolve;
    });
    const update = vi.fn(() => response);
    act(() => {
      renderer = create(<SettingsLayout connected update={update} />);
    });
    let operation!: Promise<DesktopTritonAiCredentialsUpdateResult>;
    act(() => {
      operation = current.updateCredentials({ route: "on-prem", apiKey: "test-key" });
    });
    expect(current.phase).toBe("saving");
    act(() => {
      renderer!.update(<SettingsLayout connected={false} update={update} />);
    });
    expect(current.phase).toBe("saving");
    await act(async () => {
      finish(saved);
      await operation;
    });
    expect(current.phase).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(10_000));
    expect(current.phase).toBe("timed-out");
    act(() => {
      renderer!.update(<SettingsLayout connected update={update} />);
    });
    expect(current.phase).toBe("idle");
  });

  it("resets page state when the user chooses another device", async () => {
    const update = vi.fn(async () => saved);
    act(() => {
      renderer = create(<SettingsLayout connected={false} update={update} />);
    });
    await act(async () => {
      await current.updateCredentials({ route: "frontier", remove: true });
    });
    expect(current.phase).toBe("reconnecting");
    act(() => {
      renderer!.update(<SettingsLayout connected={false} machine={remoteId} update={update} />);
    });
    expect(current.phase).toBe("idle");
  });
});
