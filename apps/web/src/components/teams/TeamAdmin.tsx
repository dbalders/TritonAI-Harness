import type { TeamCommand, TeamsResult } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

export type HeldTeam = TeamsResult["teams"][number];

/**
 * Teams that aren't ready, for a Teams administrator. Opening one uses the page's own team view;
 * a recheck goes through the page so its result and confirmation live with the other changes.
 */
export function HeldTeams({
  execute,
  disabled,
  onOpen,
  onRecheck,
}: {
  execute: (command: TeamCommand) => Promise<TeamsResult>;
  disabled: boolean;
  onOpen: (teamId: string) => void;
  onRecheck: (team: HeldTeam) => void;
}) {
  const [teams, setTeams] = useState<readonly HeldTeam[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await execute({ action: "admin-list" });
      if (generation.current === request) setTeams(result.teams);
    } catch (cause) {
      if (generation.current === request)
        setError(cause instanceof Error ? cause.message : "Teams could not be reached.");
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }, [execute]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Teams needing attention</h3>
        <Button variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? "Loading…" : "Refresh list"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Only Teams administrators see this. Check again verifies a team folder’s SharePoint
        permissions against the team’s recorded members, and makes the team ready if they match.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {teams === null ? null : teams.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border px-3">
          {teams.map((team) => (
            <li key={team.id} className="flex flex-wrap items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{team.name}</p>
                <p className="text-xs text-muted-foreground">
                  {team.reference} ·{" "}
                  {team.state === "provisioning" ? "Stuck setting up" : "Needs attention"}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-label={`Open ${team.name}`}
                onClick={() => onOpen(team.id)}
              >
                Open
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={`Check ${team.name} again`}
                onClick={() => onRecheck(team)}
              >
                Check again
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No teams need attention.</p>
      )}
    </section>
  );
}
