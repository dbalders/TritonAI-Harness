import type { DesktopBridge } from "@t3tools/contracts";
import { createContext, useEffect, useState, type ReactNode } from "react";
import { usePrimaryEnvironment } from "../../state/environments";

type UpdateCredentials = DesktopBridge["updateTritonAiCredentials"];
type UpdatePhase = "idle" | "saving" | "reconnecting" | "timed-out";

export const TritonAiCredentialUpdateContext = createContext<{
  readonly phase: UpdatePhase;
  readonly updateCredentials: UpdateCredentials;
} | null>(null);

function useTritonAiCredentialUpdate(update: UpdateCredentials, connected: boolean) {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const updateCredentials: UpdateCredentials = async (input) => {
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
  };

  if (connected && (phase === "reconnecting" || phase === "timed-out")) {
    setPhase("idle");
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the credential-update reconnect timeout and cancel it once the connection returns.
  useEffect(() => {
    if (connected || phase !== "reconnecting") return;
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
