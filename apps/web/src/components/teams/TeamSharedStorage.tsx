import { mergeTeamStorageResult } from "@t3tools/client-runtime/state/server";
import type { EnvironmentId, TeamStorageCommand, TeamStorageStatus } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { TeamDocuments } from "./TeamDocuments";

/** Mounted only for the current account and a ready team; no cross-account or persistent UI cache. */
export function TeamSharedStorage({
  environmentId,
  teamId,
  canWrite,
}: {
  environmentId: EnvironmentId;
  teamId: string;
  canWrite: boolean;
}) {
  const request = useAtomCommand(serverEnvironment.teamStorage, { reportFailure: false });
  const [state, setState] = useState<TeamStorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const run = useCallback(
    async (input: TeamStorageCommand) => {
      if (inFlight.current) return null;
      inFlight.current = true;
      const requestId = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const response = await request({ environmentId, input });
        if (response._tag !== "Success") throw squashAtomCommandFailure(response);
        if (generation.current !== requestId) return null;
        const next = response.value;
        setState((previous) => mergeTeamStorageResult(previous, next, input));
        if (input.action === "connect" && next.verificationUri)
          await ensureLocalApi().shell.openExternal(next.verificationUri);
        return next;
      } catch (cause) {
        if (generation.current === requestId) {
          if (
            !(
              cause instanceof Error &&
              "code" in cause &&
              (cause.code === "conflict" ||
                cause.code === "unavailable" ||
                cause.code === "invalid_request")
            )
          )
            setState(null);
          setError(cause instanceof Error ? cause.message : "Shared storage is unavailable.");
        }
        return null;
      } finally {
        if (generation.current === requestId) {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    [environmentId, request],
  );
  useEffect(() => {
    void run({ action: "status", teamId });
    return () => {
      generation.current++;
      inFlight.current = false;
    };
  }, [run, teamId]);
  useEffect(() => {
    if (state?.status !== "pending" || !state.flowId || busy) return;
    if (state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) return;
    const timer = setTimeout(
      () => void run({ action: "poll", teamId, flowId: state.flowId! }),
      Math.max(1, state.retryAfterSeconds ?? 5) * 1000,
    );
    return () => clearTimeout(timer);
  }, [busy, run, state, teamId]);
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <h4 className="text-sm font-medium">Shared storage</h4>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state?.status === "not-configured" ? (
        <p className="text-sm text-muted-foreground">
          Your administrator needs to finish the Microsoft storage connection for this environment.
        </p>
      ) : null}
      {state?.status === "disconnected" ? (
        <p className="text-sm text-muted-foreground">
          Connect your UCSD Microsoft account to open this team’s shared files inside Harness.
        </p>
      ) : null}
      {state?.status === "pending" ? (
        <div className="space-y-2 rounded-lg bg-muted/40 p-3 text-sm">
          <p>Enter this code on the Microsoft sign-in page using your UCSD account.</p>
          <p className="select-all font-mono font-semibold tracking-widest">{state.userCode}</p>
          {state.verificationUri ? (
            <Button
              variant="outline"
              onClick={() => void ensureLocalApi().shell.openExternal(state.verificationUri!)}
            >
              Reopen Microsoft sign-in
            </Button>
          ) : null}
          {state.expiresAt ? (
            <p className="text-xs text-muted-foreground">
              Code expires {new Date(state.expiresAt).toLocaleTimeString()}.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state?.status === "disconnected" ? (
          <Button disabled={busy} onClick={() => void run({ action: "connect", teamId })}>
            Connect Microsoft
          </Button>
        ) : null}
        {state?.status === "connected" ? (
          <>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void run({ action: "list-files", teamId })}
            >
              {busy ? "Loading files…" : "Refresh shared files"}
            </Button>
            <Button
              disabled={busy}
              variant="ghost"
              onClick={() => void run({ action: "disconnect", teamId })}
            >
              Disconnect Microsoft
            </Button>
          </>
        ) : null}
        {state?.status === "pending" ? (
          <Button
            disabled={busy}
            variant="ghost"
            onClick={() => void run({ action: "disconnect", teamId })}
          >
            Cancel
          </Button>
        ) : null}
        {error || !state ? (
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => void run({ action: "status", teamId })}
          >
            {busy ? "Checking storage…" : "Retry storage connection"}
          </Button>
        ) : null}
      </div>
      {state?.files.length ? (
        <ul className="divide-y divide-border text-sm">
          {state.files.map((file) => (
            <li key={file.id} className="flex justify-between gap-4 py-2">
              <span className="break-all">{file.path}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {Math.ceil(file.size / 1024)} KB
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {state?.status === "connected" ? (
        <TeamDocuments
          teamId={teamId}
          document={state.document}
          files={state.files}
          canWrite={canWrite}
          busy={busy}
          run={run}
        />
      ) : null}
    </section>
  );
}
