import { useStableCallback } from "../../hooks/useStableCallback";
import type { EnvironmentId, TeamMemoryMirror, TeamProjectCommand } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { useTeamProjectRequest } from "./TeamProjects";

export interface TeamMemoryCopies {
  readonly mirrors: readonly TeamMemoryMirror[] | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly apply: (
    command: Extract<TeamProjectCommand, { action: `mirror-${string}` }>,
  ) => Promise<void>;
}

/** This environment's local copies of team memory for the signed-in campus account. */
export function useTeamMemoryCopies(environmentId: EnvironmentId): TeamMemoryCopies {
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const [mirrors, setMirrors] = useState<readonly TeamMemoryMirror[] | null>(null);
  const apply: TeamMemoryCopies["apply"] = useStableCallback(
    async (command: Parameters<TeamMemoryCopies["apply"]>[0]) => {
      const result = await run(command);
      if (result && !("error" in result) && result.mirrors) setMirrors(result.mirrors);
    },
  );
  useEffect(() => {
    void apply({ action: "mirror-list" });
  }, [apply]);
  return { mirrors, busy, error, apply };
}

function describeTeamCopy(mirror: TeamMemoryMirror): string {
  if (mirror.state === "detached") return mirror.message ?? "Detached. The local copy was removed.";
  if (mirror.state === "off")
    return "Off. You stopped this copy, so agents here don't see this team's memory.";
  const when = mirror.lastSyncedAt
    ? `Updated ${new Date(mirror.lastSyncedAt).toLocaleString()}.`
    : "Waiting for the first copy.";
  return mirror.message ? `${when} ${mirror.message}` : when;
}

/**
 * Every local copy, including teams this account can no longer open, so a detached copy stays
 * visible after the team itself disappears from the list.
 */
export function TeamMemoryCopyList({ copies }: { copies: TeamMemoryCopies }) {
  const { mirrors, busy, error, apply } = copies;
  if (!mirrors?.length && !error) return null;
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium">Local copies in memory</h3>
          <p className="text-xs text-muted-foreground">
            Read-only copies of each of your teams’ daily memory, notes, and SOPs in this
            environment’s memory folder, so agents in any project can look through them. Skills are
            never copied.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void apply({ action: "mirror-list" })}
        >
          Check again
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {mirrors?.map((mirror) => (
          <li key={mirror.teamId} className="flex flex-wrap items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {mirror.teamName}
                {mirror.state === "detached"
                  ? " · Detached"
                  : mirror.state === "off"
                    ? " · Off"
                    : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                <code>{mirror.folder}</code> · {describeTeamCopy(mirror)}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void apply({
                  action: mirror.state === "off" ? "mirror-on" : "mirror-off",
                  teamId: mirror.teamId,
                })
              }
            >
              {mirror.state === "detached"
                ? "Dismiss"
                : mirror.state === "off"
                  ? "Keep a local copy"
                  : "Stop local copy"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The way out of a team's automatic local copy, and back in, beside its project links. */
export function TeamMemoryCopyControl({
  copies,
  teamId,
}: {
  copies: TeamMemoryCopies;
  teamId: string;
}) {
  const { mirrors, busy, apply } = copies;
  const mirror = mirrors?.find((entry) => entry.teamId === teamId);
  const on = mirror?.state === "mirrored";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm">Local copy in memory</p>
        <p className="text-xs text-muted-foreground">
          {mirror
            ? describeTeamCopy(mirror)
            : "Harness keeps a read-only copy of this team’s daily memory, notes, and SOPs in your memory folder, starting with the next sync."}
        </p>
      </div>
      {on ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void apply({ action: "mirror-off", teamId })}
        >
          Stop local copy
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || mirrors === null || mirror?.state === "detached"}
          onClick={() => void apply({ action: "mirror-on", teamId })}
        >
          Keep a local copy
        </Button>
      )}
    </div>
  );
}
