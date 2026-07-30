import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { UsageWarningTracker } from "./TritonAiUsageWarning.logic";

const REMAINING_PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

type ToastId = ReturnType<typeof toastManager.add>;

const usageWarningTracker = new UsageWarningTracker();

export function TritonAiUsageWarning() {
  const navigate = useNavigate();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.tritonAiUsage({ environmentId, input: {} }),
  );
  const activeToastRef = useRef<ToastId | null>(null);

  useEffect(() => {
    return () => {
      if (activeToastRef.current !== null) {
        toastManager.close(activeToastRef.current);
        activeToastRef.current = null;
      }
    };
  }, [environmentId]);

  useEffect(() => {
    if (environmentId === null || data === null) {
      return;
    }

    const observation = usageWarningTracker.observe(environmentId, data);
    if (observation.warning === null) {
      if (observation.activeThreshold === null && activeToastRef.current !== null) {
        toastManager.close(activeToastRef.current);
        activeToastRef.current = null;
      }
      return;
    }

    if (activeToastRef.current !== null) {
      toastManager.close(activeToastRef.current);
      activeToastRef.current = null;
    }

    const { remainingPercent, threshold } = observation.warning;
    let toastId!: ToastId;
    const closeToast = () => {
      toastManager.close(toastId);
      if (activeToastRef.current === toastId) {
        activeToastRef.current = null;
      }
    };
    const openUsage = () => {
      closeToast();
      void navigate({ to: "/settings/usage" });
    };

    toastId = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title:
          threshold === 10 ? "TritonAI usage is critically low" : "TritonAI usage is running low",
        description: `Only ${REMAINING_PERCENT_FORMAT.format(remainingPercent)}% of this key's budget remains.`,
        timeout: 0,
        actionProps: {
          children: "View usage",
          onClick: openUsage,
        },
        actionVariant: "outline",
        data: {
          hideCopyButton: true,
          onClose: () => {
            if (activeToastRef.current === toastId) {
              activeToastRef.current = null;
            }
          },
        },
      }),
    );
    activeToastRef.current = toastId;
  }, [data, environmentId, navigate]);

  return null;
}
