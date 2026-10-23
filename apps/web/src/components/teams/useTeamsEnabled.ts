import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { serverEnvironment } from "../../state/server";

const disabled = Atom.make(false);
const enabledByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.teams.permissionAtom(environmentId)) &&
      get(serverEnvironment.settingsValueAtom(environmentId))?.experimentalTeamsEnabled === true,
  ),
);
const enabledEnvironmentIds = Atom.family((key: string) => {
  const ids = JSON.parse(key) as EnvironmentId[];
  return Atom.make((get) => new Set(ids.filter((id) => get(enabledByEnvironment(id)))));
});

/** New Teams actions require this environment's opt-in as well as the connection's grant.
 * Existing sharing notices and protected draft/send checks use the raw permission instead. */
export function useTeamsEnabled(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(environmentId === null ? disabled : enabledByEnvironment(environmentId));
}

/** Settings can span several destinations; each environment retains its own opt-in. */
export function useTeamsEnabledEnvironments(
  environments: readonly { readonly environmentId: EnvironmentId }[],
): ReadonlySet<EnvironmentId> {
  return useAtomValue(
    enabledEnvironmentIds(JSON.stringify(environments.map((e) => e.environmentId))),
  );
}
