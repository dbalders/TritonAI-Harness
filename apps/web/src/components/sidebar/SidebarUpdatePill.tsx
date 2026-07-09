import {
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";

import { isElectron } from "../../env";
import { useInstallerUpdateState } from "../../state/installerUpdate";
import {
  getInstallerUpdateActionError,
  getInstallerUpdateButtonTooltip,
  isInstallerUpdateButtonDisabled,
  resolveInstallerUpdateButtonAction,
  shouldShowInstallerUpdateButton,
} from "../installerUpdate.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarUpdatePill() {
  const state = useInstallerUpdateState();
  const [dismissed, setDismissed] = useState(false);
  const visible = isElectron && shouldShowInstallerUpdateButton(state) && !dismissed;
  const action = state ? resolveInstallerUpdateButtonAction(state) : "none";
  const disabled = isInstallerUpdateButtonDisabled(state);
  const tooltip = state
    ? getInstallerUpdateButtonTooltip(state)
    : "Check for TritonAI Installer updates";

  const handleAction = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !state || disabled || action === "none") return;

    if (action === "check") {
      void bridge
        .checkInstallerUpdate()
        .then((result) => {
          if (result.state.status !== "error") return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for installer updates",
              description: result.state.message ?? "Try again after checking your network.",
            }),
          );
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for installer updates",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        });
      return;
    }

    void bridge
      .openInstallerUpdate()
      .then((result) => {
        if (result.completed) {
          toastManager.add({
            type: "success",
            title: "Installer download opened",
            description:
              "Run the full TritonAI Installer to update Harness, Codex, and managed skills.",
          });
          return;
        }
        const actionError = getInstallerUpdateActionError(result);
        if (!actionError) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open installer download",
            description: actionError,
          }),
        );
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open installer download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      });
  }, [action, disabled, state]);

  if (!visible || !state) return null;

  const hasError = state.status === "error";
  const buttonLabel =
    state.status === "opening"
      ? "Opening installer…"
      : action === "check"
        ? "Retry installer check"
        : hasError && action === "none"
          ? "Installer update unavailable"
          : state.errorContext === "open"
            ? "Retry installer download"
            : `Full installer${state.availableVersion ? ` ${state.availableVersion}` : ""}`;

  return (
    <div
      aria-live="polite"
      className={`group/update relative flex min-h-8 w-full items-center rounded-lg text-xs font-medium ${
        hasError ? "bg-destructive/10 text-destructive" : "bg-primary/15 text-primary"
      } ${disabled ? " cursor-wait opacity-70" : ""}`}
    >
      <div
        className={`pointer-events-none absolute inset-0 rounded-lg transition-colors ${
          hasError
            ? "group-has-[button.update-main:hover]/update:bg-destructive/15"
            : "group-has-[button.update-main:hover]/update:bg-primary/22"
        }`}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={tooltip}
              aria-disabled={disabled || undefined}
              disabled={disabled}
              className="update-main relative flex min-h-8 flex-1 items-center gap-2 px-2 text-left enabled:cursor-pointer"
              onClick={handleAction}
            >
              {state.status === "opening" ? (
                <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
              ) : action === "check" ? (
                <RefreshCwIcon aria-hidden="true" className="size-3.5 shrink-0" />
              ) : hasError ? (
                <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <DownloadIcon aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="truncate">{buttonLabel}</span>
            </button>
          }
        />
        <TooltipPopup side="top" className="max-w-80">
          {tooltip}
        </TooltipPopup>
      </Tooltip>
      {action === "open" && state.errorContext !== "open" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss installer update"
                className="relative mr-1 inline-flex size-5 items-center justify-center rounded-md opacity-60 transition-opacity hover:opacity-100"
                onClick={() => setDismissed(true)}
              >
                <XIcon aria-hidden="true" className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="top">Dismiss until next launch</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
