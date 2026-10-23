import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ requests: [] as EnvironmentId[] }));
const status = async ({ environmentId }: { environmentId: EnvironmentId }) => {
  mocks.requests.push(environmentId);
  return { _tag: "Success", value: { configured: true } };
};
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => status }));

const settings = Atom.family((_id: EnvironmentId) => Atom.make<ServerSettings | null>(null));
const grants = Atom.family((_id: EnvironmentId) => Atom.make(false));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    getAccountStatus: "account-status",
    settingsValueAtom: (id: EnvironmentId) => settings(id),
    teams: { permissionAtom: (id: EnvironmentId) => grants(id) },
  },
}));

import { useTeamsEnabled, useTeamsEnabledEnvironments } from "./useTeamsEnabled";
import { useTeamsConfigured } from "./useTeamsConfigured";

const laptop = EnvironmentId.make("laptop");
const remote = EnvironmentId.make("remote");

function Discovery() {
  const local = useTeamsEnabled(laptop);
  const other = useTeamsEnabled(remote);
  const missing = useTeamsEnabled(null);
  const enabled = useTeamsEnabledEnvironments([
    { environmentId: laptop },
    { environmentId: remote },
  ]);
  return <p>{`${local}:${other}:${missing}:${[...enabled].join(",")}`}</p>;
}

function setup() {
  mocks.requests.length = 0;
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

it("requires the destination environment's explicit opt-in and grant, including after changes", async () => {
  using state = setup();
  const { registry } = state;
  registry.set(grants(laptop), true);
  registry.set(settings(remote), { ...DEFAULT_SERVER_SETTINGS, experimentalTeamsEnabled: true });
  registry.set(grants(remote), true);
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Discovery />
    </RegistryContext.Provider>,
    { router: false },
  );
  expect(screen.container.textContent).toBe("false:true:false:remote");
  await act(async () => registry.set(settings(laptop), DEFAULT_SERVER_SETTINGS));
  expect(screen.container.textContent).toBe("false:true:false:remote");
  await act(async () =>
    registry.set(settings(laptop), { ...DEFAULT_SERVER_SETTINGS, experimentalTeamsEnabled: true }),
  );
  expect(screen.container.textContent).toBe("true:true:false:laptop,remote");
  await act(async () => registry.set(grants(laptop), false));
  expect(screen.container.textContent).toBe("false:true:false:remote");
  await act(async () => registry.set(settings(remote), DEFAULT_SERVER_SETTINGS));
  expect(screen.container.textContent).toBe("false:false:false:");
});

it("does not discover the account service until Teams is enabled on the requested destination", async () => {
  function Configured() {
    return <p>{String(useTeamsConfigured(laptop))}</p>;
  }
  using state = setup();
  const { registry } = state;
  registry.set(grants(laptop), true);
  registry.set(settings(remote), { ...DEFAULT_SERVER_SETTINGS, experimentalTeamsEnabled: true });
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Configured />
    </RegistryContext.Provider>,
    { router: false },
  );
  expect(screen.container.textContent).toBe("false");
  expect(mocks.requests).toEqual([]);
  await act(async () =>
    registry.set(settings(laptop), {
      ...DEFAULT_SERVER_SETTINGS,
      experimentalTeamsEnabled: true,
    }),
  );
  await expect.poll(() => screen.container.textContent).toBe("true");
  expect(mocks.requests).toEqual([laptop]);
  await act(async () => registry.set(settings(laptop), DEFAULT_SERVER_SETTINGS));
  expect(screen.container.textContent).toBe("false");
  expect(mocks.requests).toEqual([laptop]);
});
