import { useBotTaskComputerControl } from "../../hooks/useBotTaskComputerControl";
import { Button } from "../ui/button";

/** Permission retained by an earlier Nightly must be visible without visiting Settings. */
export function BotTaskComputerNotice() {
  const { earlierPairing, enabled, busy, error, change } = useBotTaskComputerControl();
  if (!earlierPairing) return null;
  return (
    <aside
      aria-label="Bot task permission"
      className="fixed right-4 top-[calc(var(--workspace-topbar-height,3rem)+1rem)] z-50 w-sm max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-lg"
    >
      <p role="status">
        Bot tasks are still allowed on this Harness by an earlier pairing, while Experimental Bot is{" "}
        {enabled ? "unavailable" : "off"}.
      </p>
      <p>Stop new assignments here. Work already running and saved result delivery can finish.</p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(false)}>
        Stop Bot tasks here
      </Button>
    </aside>
  );
}
