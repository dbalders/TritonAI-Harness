import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { isElectron } from "../../env";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";
import { UsageProviderSettings } from "../settings/UsageProviderSettings";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const usageSourceTargetsAtom = Atom.make((get) =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, environment]) => {
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    const session = get(environmentSession.sessionStateAtom(environmentId));
    const sessionAccess = {
      session: Option.getOrNull(AsyncResult.value(session)),
      isPending: session.waiting,
      hasError: session._tag === "Failure",
    };
    const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
    const access = isPrimary
      ? resolvePrimaryOperateAccess({ ...sessionAccess, isPrimary, hasDesktopBridge: isElectron })
      : resolveRemoteOperateAccess(sessionAccess);
    return {
      environmentId,
      label: environment.entry.target.label,
      settings,
      unavailable:
        environment.connection.phase !== "connected"
          ? "Offline"
          : settings === null || environment.serverConfig === null
            ? "Settings not loaded"
            : access === "pending"
              ? "Checking permissions…"
              : null,
      readOnly: access !== "granted",
    };
  }),
);

export function UsageSourcesDialog({
  onOpenChange,
}: {
  readonly onOpenChange: (open: boolean) => void;
}) {
  const environments = useAtomValue(usageSourceTargetsAtom);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Usage sources</DialogTitle>
          <DialogDescription>
            Manage Cursor account access and CLIProxyAPI hubs on your connected environments.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-6">
            {environments.map((environment) =>
              environment.unavailable || environment.settings === null ? (
                <p key={environment.environmentId} className="text-sm text-muted-foreground">
                  {environment.label}: {environment.unavailable ?? "Settings not loaded"}
                </p>
              ) : (
                <div key={environment.environmentId} className="space-y-2">
                  {environment.readOnly ? (
                    <p className="text-sm text-muted-foreground">Read-only access</p>
                  ) : null}
                  <UsageProviderSettings
                    environmentId={environment.environmentId}
                    environmentLabel={environment.label}
                    sources={environment.settings.usageLimitSources}
                    cursorKeychainUsageEnabled={environment.settings.cursorKeychainUsageEnabled}
                    readOnly={environment.readOnly}
                  />
                </div>
              ),
            )}
            {environments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No environments connected.</p>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
