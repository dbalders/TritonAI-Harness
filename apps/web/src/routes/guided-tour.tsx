import { Navigate, createFileRoute, redirect } from "@tanstack/react-router";

import { GuidedOnboarding } from "../components/onboarding/GuidedOnboarding";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";

/**
 * The experimental guided tour. Its only entry point is Settings → General →
 * Experimental; while the experiment is off, a saved or typed link goes home.
 */
export const Route = createFileRoute("/guided-tour")({
  beforeLoad: ({ context }) => {
    const { status } = context.authGateState;
    if (status === "hosted-static") {
      // The tour runs real tasks, so it needs a TritonAI server behind this app.
      throw redirect({ to: "/", replace: true });
    }
    if (status !== "authenticated") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: GuidedTourRouteView,
});

function GuidedTourRouteView() {
  const hydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.experimentalGuidedTourEnabled);
  if (!hydrated) return null;
  if (!enabled) return <Navigate to="/" replace />;
  return <GuidedOnboarding />;
}
