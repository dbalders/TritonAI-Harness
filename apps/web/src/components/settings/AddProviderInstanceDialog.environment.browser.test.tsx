import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { EnvironmentId, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const actions = vi.hoisted(() => ({
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  canManageProviders: true,
}));
const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} })),
  mutate: vi.fn(),
  useMutation: vi.fn(),
}));
const preparedAgent = vi.hoisted((): AcpRegistrySearchAgent => ({
  id: "kilo",
  name: "Kilo Code",
  version: "4.2.0",
  description: "Kilo ACP agent",
  authors: ["Kilo"],
  license: "Apache-2.0",
  website: null,
  repository: null,
  icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/kilo.svg",
  distribution: "binary",
  integrity: "sha256",
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: settingsHooks.read as never,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: actions.toast } };
});
// The registry search and the sign-in step talk to the environment over RPC; these
// stand-ins expose the choices a user makes there.
vi.mock(import("./AcpRegistrySearchStep"), async (original) => ({
  ...(await original()),
  AcpRegistrySearchStep: ((props: {
    onPrepared: (agent: AcpRegistrySearchAgent) => void;
    onManualConfiguration: () => void;
    onLocalConfiguration: () => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onPrepared(preparedAgent)}>
        Use Kilo Code
      </button>
      <button type="button" onClick={props.onManualConfiguration}>
        Enter registry agent
      </button>
      <button type="button" onClick={props.onLocalConfiguration}>
        Use local command
      </button>
    </div>
  )) as never,
}));
vi.mock(import("./ProviderWizardAuthenticationStep"), async (original) => ({
  ...(await original()),
  ProviderWizardAuthenticationStep: (props: {
    environmentId: string;
    instanceId: string;
    onFinish: () => void;
  }) => (
    <section aria-label="Sign-in step">
      {props.environmentId}/{props.instanceId}
      <button type="button" onClick={props.onFinish}>
        Finish sign-in
      </button>
    </section>
  ),
}));

const remoteEnvironmentId = EnvironmentId.make("remote-device");

const dialog = () => (
  <AddProviderInstanceDialog
    open
    environmentId={remoteEnvironmentId}
    environmentLabel="Remote device"
    onOpenChange={actions.onOpenChange}
  />
);
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
const click = (label: string) => act(async () => button(label).click());
const input = (selector: string) => {
  const found = document.querySelector<HTMLInputElement>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};
async function type(selector: string, value: string) {
  await userEvent.fill(input(selector), value);
  await act(async () => input(selector).blur());
}

async function prepareCodexInstance() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(dialog()));
  await click("Configure manually");
  await type("#add-provider-label", "Work");
  await click("Next");
  stack.move();
  return screen;
}

function setup() {
  actions.canManageProviders = true;
  actions.toast.mockReset();
  actions.onOpenChange.mockReset();
  settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
  settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
}

describe("AddProviderInstanceDialog environment routing", () => {
  it("offers only the managed Codex driver and uses its default identity", async () => {
    setup();
    await using screen = await render(dialog());
    expect(screen.container.textContent).not.toMatch(/Grok|Claude|ACP Registry/);
    await click("Configure manually");
    await click("Next");
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_2",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "TritonAI",
        config: { setupMode: "existing" },
      },
    });
  });

  it("chooses an unused identity for another account without replacing configured instances", async () => {
    setup();
    settingsHooks.read.mockReturnValue({
      providerInstances: { codex_2: { driver: "codex", enabled: false } },
    });
    await using _screen = await render(dialog());
    await click("Configure manually");
    await click("Next");
    await click("Add instance");
    expect(settingsHooks.mutate).toHaveBeenCalledWith({
      operation: "create",
      instanceId: "codex_3",
      instance: {
        driver: "codex",
        enabled: true,
        displayName: "TritonAI",
        config: { setupMode: "existing" },
      },
    });
  });

  it("rejects a queued save after the provider grant is revoked", async () => {
    setup();
    await using screen = await prepareCodexInstance();
    const save = button("Add instance");
    actions.canManageProviders = false;
    // The rendered button is still enabled; the click must recheck the live grant.
    await act(async () => save.click());

    expect(settingsHooks.mutate).not.toHaveBeenCalled();
    expect(actions.toast).not.toHaveBeenCalled();
    expect(actions.onOpenChange).not.toHaveBeenCalled();
    await screen.rerender(dialog());
    expect(button("Add instance").disabled).toBe(true);
  });
});
