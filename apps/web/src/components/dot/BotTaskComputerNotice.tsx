import { useEffect, useEffectEvent } from "react";
import { useBotTaskComputerControl } from "../../hooks/useBotTaskComputerControl";
import { Button } from "../ui/button";

/** Harness permission stays visible even when this client's Bot screens are hidden. */
export function BotTaskComputerNotice() {
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
      className="fixed right-4 top-[calc(var(--workspace-topbar-height,3rem)+1rem)] z-50 w-sm max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
    >
      <p role="status">
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
        Stopping tasks here affects every client of this Harness. Work already running and saved
        result delivery can finish.
      </p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(false)}>
          Stop Bot tasks here
        </Button>
        {hiddenPairing && !enabled && serviceUrl ? (
          <Button size="sm" disabled={busy} onClick={() => void change(true)}>
            Turn on Experimental Bot
          </Button>
        ) : null}
      </div>
    </aside>
  );
}
