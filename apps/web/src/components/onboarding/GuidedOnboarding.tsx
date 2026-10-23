import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { getClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { openGettingStarted } from "../../onboarding/gettingStartedState";
import { Button } from "../ui/button";

/** Keep saved tour links working while the guide lives beside ordinary app routes. */
export function GuidedOnboarding() {
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const current = useRef(0);
  const [failed, setFailed] = useState(false);
  const open = useStableCallback(async () => {
    if (!environmentId) return;
    const operation = current.current;
    setFailed(false);
    const saved = await openGettingStarted(environmentId);
    if (operation !== current.current || !getClientSettings().experimentalGuidedTourEnabled) return;
    if (saved) void navigate({ to: "/", replace: true });
    else setFailed(true);
  });
  useEffect(() => {
    if (!environmentId) return;
    void open();
    return () => {
      current.current += 1;
    };
  }, [environmentId, open]);
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <p role="status">
        {failed ? "Could not open your saved chapters." : "Opening your chapters…"}
      </p>
      {failed ? (
        <Button variant="outline" onClick={() => void open()}>
          Try again
        </Button>
      ) : null}
    </main>
  );
}
