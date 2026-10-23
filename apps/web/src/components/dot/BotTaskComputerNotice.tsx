import { useEffect, useEffectEvent, useId, useState } from "react";
import { useBotTaskComputerControl } from "../../hooks/useBotTaskComputerControl";
import { Button } from "../ui/button";

/** Harness permission stays visible even when this client's Bot screens are hidden. */
export function BotTaskComputerNotice() {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const detailsId = useId();
  const {
    hiddenPairing,
    permissionUnknown,
    enabled,
    environmentId,
    serviceUrl,
    busy,
    error,
    change,
    refreshLocal,
  } = useBotTaskComputerControl();
  const refreshOnArrival = useEffectEvent(() => refreshLocal());
  useEffect(() => {
    if (!environmentId) return;
    const discover = () => {
      if (document.visibilityState === "visible") refreshOnArrival();
    };
    window.addEventListener("focus", discover);
    document.addEventListener("visibilitychange", discover);
    return () => {
      window.removeEventListener("focus", discover);
      document.removeEventListener("visibilitychange", discover);
    };
  }, [environmentId]);
  if (!hiddenPairing && !permissionUnknown) return null;
  return (
    <aside
      aria-label="Bot task permission"
      className="fixed right-4 top-[calc(var(--workspace-topbar-height,3rem)+1rem)] z-50 w-sm max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-3">
        <p role="status" className="min-w-0 flex-1">
          {permissionUnknown
            ? "Bot task permission is unknown."
            : "Bot tasks are allowed on this Harness."}
        </p>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={detailsExpanded}
          aria-controls={detailsId}
          onClick={() => setDetailsExpanded((expanded) => !expanded)}
        >
          {detailsExpanded ? "Hide details" : "Show details"}
        </Button>
      </div>
      <div id={detailsId} hidden={!detailsExpanded} className="space-y-3">
        {detailsExpanded ? (
          <>
            <p>
              {permissionUnknown ? (
                "Bot task permission on this Harness cannot currently be checked. Retrying automatically."
              ) : (
                <>
                  Bot tasks are allowed on this Harness. Experimental Bot is{" "}
                  {enabled ? "unavailable" : "off"} in this app.
                </>
              )}
            </p>
            <p>
              Stopping tasks here signs you out of Bot in this app, turns off Experimental Bot here,
              and stops new assignments for every client of this Harness. Work already running and
              saved result delivery can finish.
            </p>
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void change(false)}
              >
                Stop Bot tasks here
              </Button>
              {hiddenPairing && !enabled && serviceUrl ? (
                <Button size="sm" disabled={busy} onClick={() => void change(true)}>
                  Turn on Experimental Bot
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}
