import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type DesktopTritonAiCredentialsUpdateResult,
} from "@t3tools/contracts";
import { act, fakeTimers, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
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
function CredentialOwner({
  connected,
  update,
}: {
  connected: boolean;
  update: Parameters<typeof useTritonAiCredentialUpdate>[0];
}) {
  const value = useTritonAiCredentialUpdate(update, connected);
  return (
    <>
      <p data-testid="phase">{value.phase}</p>
      <button
        onClick={() => void value.updateCredentials({ route: "on-prem", apiKey: "test-key" })}
      >
        Save credentials
      </button>
    </>
  );
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

describe("provider settings restart ownership", () => {
  it("retains key-update progress when the connected representative disappears", async () => {
    let finish!: (result: DesktopTritonAiCredentialsUpdateResult) => void;
    const response = new Promise<DesktopTritonAiCredentialsUpdateResult>((resolve) => {
      finish = resolve;
    });
    const update = vi.fn(() => response);
    await using screen = await render(<SettingsLayout connected update={update} />);
    using _timers = fakeTimers();
    await act(() => screen.container.querySelector("button")!.click());
    expect(screen.container.querySelector("p")?.textContent).toBe("saving");
    await screen.rerender(<SettingsLayout connected={false} update={update} />);
    expect(screen.container.querySelector("p")?.textContent).toBe("saving");
    await act(async () => {
      finish(saved);
      await response;
    });
    expect(screen.container.querySelector("p")?.textContent).toBe("reconnecting");
    await act(() => vi.advanceTimersByTime(10_000));
    expect(screen.container.querySelector("p")?.textContent).toBe("timed-out");
    await screen.rerender(<SettingsLayout connected update={update} />);
    expect(screen.container.querySelector("p")?.textContent).toBe("idle");
  });
  it("resets page state when the user chooses another device", async () => {
    const update = vi.fn(async () => saved);
    await using screen = await render(<SettingsLayout connected={false} update={update} />);
    await act(() => screen.container.querySelector("button")!.click());
    expect(screen.container.querySelector("p")?.textContent).toBe("reconnecting");
    await screen.rerender(<SettingsLayout connected={false} machine={remoteId} update={update} />);
    expect(screen.container.querySelector("p")?.textContent).toBe("idle");
  });
});
