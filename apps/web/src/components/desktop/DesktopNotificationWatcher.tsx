import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  isHarnessInBackground,
  makeDesktopNotificationThreadMap,
  observeDesktopNotificationThreads,
  planDesktopNotificationDeliveries,
  showDesktopNotification,
  showDesktopNotificationSummary,
  type DesktopNotificationThreadMap,
} from "../../desktopNotifications";
import { isElectron } from "../../env";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
import { useThreadShells } from "../../state/entities";

/**
 * Observes the existing shell projection without changing task lifecycle or
 * orchestration state. Notifications are a desktop-only presentation effect.
 */
export function DesktopNotificationWatcher() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const settingsHydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.desktopNotificationsEnabled);
  const previousThreadsRef = useRef<DesktopNotificationThreadMap | null>(null);

  useEffect(() => {
    const nextThreads = makeDesktopNotificationThreadMap(threads);
    const observation = observeDesktopNotificationThreads(
      previousThreadsRef.current,
      nextThreads,
      isElectron && settingsHydrated && enabled,
    );
    previousThreadsRef.current = observation.baseline;

    if (!isElectron || !settingsHydrated || !enabled || !isHarnessInBackground()) {
      return;
    }

    for (const delivery of planDesktopNotificationDeliveries(observation.intents)) {
      if (delivery.type === "summary") {
        showDesktopNotificationSummary(delivery.count, () => {
          void navigate({ to: "/" });
        });
        continue;
      }

      const intent = delivery.intent;
      showDesktopNotification(intent, () => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: intent.environmentId,
            threadId: intent.threadId,
          },
        });
      });
    }
  }, [enabled, navigate, settingsHydrated, threads]);

  return null;
}
