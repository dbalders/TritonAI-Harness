import { useEffect, useState } from "react";

import {
  getDesktopNotificationPermission,
  requestDesktopNotificationPermission,
  showTestDesktopNotification,
  type DesktopNotificationPermission,
} from "../../desktopNotifications";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

function notificationDescription(permission: DesktopNotificationPermission): string {
  switch (permission) {
    case "denied":
      return "Blocked in system notification settings. Allow TritonAI Harness there to use this option.";
    case "unsupported":
      return "System notifications are unavailable in this desktop build.";
    default:
      return "Show a system notification when a background task finishes or needs your attention.";
  }
}

export function DesktopNotificationsSettingsRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [permission, setPermission] = useState<DesktopNotificationPermission>(() =>
    getDesktopNotificationPermission(),
  );
  const [requestingPermission, setRequestingPermission] = useState(false);

  useEffect(() => {
    const syncPermission = () => setPermission(getDesktopNotificationPermission());
    window.addEventListener("focus", syncPermission);
    return () => window.removeEventListener("focus", syncPermission);
  }, []);

  const setEnabled = async (checked: boolean) => {
    if (!checked) {
      updateSettings({ desktopNotificationsEnabled: false });
      return;
    }

    setRequestingPermission(true);
    try {
      const nextPermission = await requestDesktopNotificationPermission();
      setPermission(nextPermission);
      if (nextPermission === "granted") {
        updateSettings({ desktopNotificationsEnabled: true });
        return;
      }

      updateSettings({ desktopNotificationsEnabled: false });
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Desktop notifications remain off",
          description:
            nextPermission === "denied"
              ? "Allow TritonAI Harness in your system notification settings, then try again."
              : "This desktop build could not request notification permission.",
        }),
      );
    } catch (error) {
      updateSettings({ desktopNotificationsEnabled: false });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not enable desktop notifications",
          description: error instanceof Error ? error.message : "Unknown notification error.",
        }),
      );
    } finally {
      setRequestingPermission(false);
    }
  };

  const sendTestNotification = () => {
    if (showTestDesktopNotification()) {
      return;
    }
    setPermission(getDesktopNotificationPermission());
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Test notification was not sent",
        description: "Check the system notification permission for TritonAI Harness.",
      }),
    );
  };

  return (
    <SettingsRow
      title="Desktop notifications"
      description={notificationDescription(permission)}
      resetAction={
        settings.desktopNotificationsEnabled ? (
          <SettingResetButton
            label="desktop notifications"
            onClick={() => updateSettings({ desktopNotificationsEnabled: false })}
          />
        ) : null
      }
      control={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={
              !settings.desktopNotificationsEnabled ||
              permission !== "granted" ||
              requestingPermission
            }
            onClick={sendTestNotification}
          >
            Send test
          </Button>
          <Switch
            checked={settings.desktopNotificationsEnabled}
            disabled={requestingPermission || permission === "unsupported"}
            onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
            aria-label="Enable desktop notifications"
          />
        </>
      }
    />
  );
}
