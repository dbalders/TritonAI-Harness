import type { DesktopBridge } from "@t3tools/contracts";
import { createContext, useCallback, useEffect, useState, type ReactNode } from "react";

import { usePrimaryEnvironment } from "../../state/environments";

type UpdateCredentials = DesktopBridge["updateTritonAiCredentials"];
type UpdatePhase = "idle" | "saving" | "reconnecting" | "timed-out";

export const TritonAiCredentialUpdateContext = createContext<{
  readonly phase: UpdatePhase;
  readonly updateCredentials: UpdateCredentials;
} | null>(null);

export function useTritonAiCredentialUpdate(update: UpdateCredentials, connected: boolean) {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const updateCredentials: UpdateCredentials = useCallback(
    async (input) => {
      setPhase("saving");
      try {
        // IPC waits for backend readiness; the client may still need to reconnect.
        const result = await update(input);
        setPhase(result.status === "saved" ? "reconnecting" : "idle");
        return result;
      } catch (error) {
        setPhase("idle");
        throw error;
      }
    },
    [update],
  );

  useEffect(() => {
    if (phase !== "reconnecting" && phase !== "timed-out") return;
    if (connected) {
      setPhase("idle");
      return;
    }
    if (phase === "timed-out") return;
    const timeout = window.setTimeout(() => setPhase("timed-out"), 10_000);
    return () => window.clearTimeout(timeout);
  }, [connected, phase]);

  return { phase, updateCredentials };
}

export function TritonAiCredentialUpdateProvider({ children }: { readonly children: ReactNode }) {
  const environment = usePrimaryEnvironment();
  const update = useTritonAiCredentialUpdate(
    async (input) => {
      if (!window.desktopBridge) throw new Error("Desktop access is unavailable.");
      return window.desktopBridge.updateTritonAiCredentials(input);
    },
    environment?.connection.phase === "connected" && environment.serverConfig !== null,
  );
  // This owner stays mounted when the connection gate removes the provider form.
  return (
    <TritonAiCredentialUpdateContext value={update}>{children}</TritonAiCredentialUpdateContext>
  );
}
