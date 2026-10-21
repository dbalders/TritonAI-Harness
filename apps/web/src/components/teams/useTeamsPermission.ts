import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { serverEnvironment } from "../../state/server";

const noTeamsPermission = Atom.make(false);

/** The destination environment's grant controls every Teams entry point. */
export function useTeamsPermission(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? noTeamsPermission
      : serverEnvironment.teams.permissionAtom(environmentId),
  );
}
