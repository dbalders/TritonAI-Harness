import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerMemorySyncStartResult } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export type MemoryDeviceCodeFlow = Extract<ServerMemorySyncStartResult, { kind: "device_code" }>;
export type MemorySyncAction = "start" | "stop" | "sync" | "sign-out";

export interface MemorySyncOperation {
  readonly busy: boolean;
  readonly flow: MemoryDeviceCodeFlow | null;
  readonly error: string | null;
}

/** Each computer owns its request and sign-in; one failure never cancels another. */
export function useMemorySyncActions(refresh: (id: EnvironmentId) => void) {
  const start = useAtomCommand(serverEnvironment.startMemorySync, { reportFailure: false });
  const stop = useAtomCommand(serverEnvironment.stopMemorySync, { reportFailure: false });
  const sync = useAtomCommand(serverEnvironment.syncMemoryNow, { reportFailure: false });
  const signOut = useAtomCommand(serverEnvironment.signOutMemorySync, { reportFailure: false });
  const [operations, setOperations] = useState<Readonly<Record<string, MemorySyncOperation>>>({});
  const busy = useRef(new Set<EnvironmentId>());

  const finishSignIn = (id: EnvironmentId, error: string | null) => {
    setOperations((current) => ({ ...current, [id]: { busy: false, flow: null, error } }));
    refresh(id);
  };

  const run = async (id: EnvironmentId, action: MemorySyncAction) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    setOperations((current) => ({
      ...current,
      [id]: { busy: true, flow: null, error: null },
    }));
    return await (async () => {
      const command =
        action === "start" ? start : action === "stop" ? stop : action === "sync" ? sync : signOut;
      const result = await command({ environmentId: id, input: {} });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setOperations((current) => ({
          ...current,
          [id]: {
            busy: false,
            flow: null,
            error: isAtomCommandInterrupted(result)
              ? null
              : failure instanceof Error
                ? failure.message
                : "Could not update memory sync.",
          },
        }));
      } else {
        const flow =
          action === "start" && "kind" in result.value && result.value.kind === "device_code"
            ? result.value
            : null;
        setOperations((current) => ({ ...current, [id]: { busy: false, flow, error: null } }));
      }
    })().finally(async () => {
      busy.current.delete(id);
      refresh(id);
    });
  };

  return { operations, run, finishSignIn };
}
