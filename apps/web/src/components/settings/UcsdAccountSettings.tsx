import {
  accountCommandValue,
  createAccountLoginController,
} from "@t3tools/client-runtime/state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { accountCallbackId } from "@t3tools/shared/accountCallback";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function AccountConnection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const preparedConnection = usePreparedConnection(environmentId);
  const getStatus = useAtomCommand(serverEnvironment.getAccountStatus, { reportFailure: false });
  const start = useAtomCommand(serverEnvironment.startAccountLogin, { reportFailure: false });
  const poll = useAtomCommand(serverEnvironment.pollAccountLogin, { reportFailure: false });
  const signOut = useAtomCommand(serverEnvironment.signOutAccount, { reportFailure: false });
  const controller = useMemo(
    () =>
      createAccountLoginController({
        getStatus: async () => accountCommandValue(await getStatus({ environmentId, input: {} })),
        start: async () => {
          const bridge = window.desktopBridge?.accountLogin;
          if (!bridge) return accountCommandValue(await start({ environmentId, input: {} }));
          const receiver = await bridge.prepare();
          try {
            const account = accountCommandValue(
              await start({ environmentId, input: { returnUrl: receiver.returnUrl } }),
            );
            if (account.returnUrl !== receiver.returnUrl) await bridge.cancel(receiver.id);
            return account;
          } catch (error) {
            await bridge.cancel(receiver.id);
            throw error;
          }
        },
        poll: async (account) => {
          const id = account.returnUrl ? accountCallbackId(account.returnUrl) : null;
          const bridge = window.desktopBridge?.accountLogin;
          const completion = id && bridge ? await bridge.read(id) : null;
          const next = accountCommandValue(await poll({ environmentId, input: completion ?? {} }));
          if (id && bridge && next.status !== "pending") await bridge.cancel(id);
          return next;
        },
        signOut: async (account) => {
          const id = account?.returnUrl ? accountCallbackId(account.returnUrl) : null;
          if (id) await window.desktopBridge?.accountLogin?.cancel(id);
          return accountCommandValue(await signOut({ environmentId, input: {} }));
        },
        openExternal: (url) => ensureLocalApi().shell.openExternal(url),
        now: Date.now,
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      }),
    [environmentId, getStatus, poll, signOut, start],
  );
  const { account, busy, error, checkedAt } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(() => {
    if (preparedConnection._tag === "None") return;
    return controller.activate();
  }, [controller, preparedConnection]);
  useEffect(() => {
    const checkOnReturn = () => {
      void controller.check();
    };
    window.addEventListener("focus", checkOnReturn);
    return () => window.removeEventListener("focus", checkOnReturn);
  }, [controller]);

  const pending = account?.status === "pending";
  const signedIn = account?.status === "signed-in";
  const description =
    account === null
      ? error
        ? "Account status is unavailable."
        : "Checking account availability…"
      : !account.configured
        ? "UC San Diego sign-in is not available on this environment yet."
        : signedIn
          ? `${account.profile?.displayName ?? "UC San Diego account"} · ${account.profile?.email ?? ""}`
          : pending
            ? "Finish signing in with your UC San Diego account in your browser."
            : "Sign in to connect your UC San Diego account to this environment.";

  return (
    <SettingsRow
      title={signedIn ? "Signed in" : pending ? "Waiting for sign-in" : "Account"}
      description={description}
      status={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : checkedAt ? (
          <span role="status">
            Connection verified at {new Date(checkedAt).toLocaleTimeString()}.
          </span>
        ) : undefined
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          {account?.configured && !pending && !signedIn ? (
            <Button size="xs" disabled={busy} onClick={() => void controller.signIn()}>
              Sign in with UC San Diego
            </Button>
          ) : null}
          {pending ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !account.verificationUrl}
              onClick={() => void controller.reopenBrowser()}
            >
              Reopen browser
            </Button>
          ) : null}
          {pending || signedIn ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void controller.signOut()}
            >
              {pending ? "Cancel" : "Sign out"}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void controller.check()}
          >
            {busy ? "Connecting…" : account?.configured ? "Check connection" : "Check availability"}
          </Button>
        </div>
      }
    >
      {pending && account.userCode ? (
        <div role="status" className="mt-3 rounded-md border border-border px-3 py-2 text-sm">
          Confirm this code matches the sign-in page:{" "}
          <strong className="ml-2 select-all font-mono tracking-wider">{account.userCode}</strong>
        </div>
      ) : null}
      {signedIn && account?.renewalExpiresAt ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Your sign-in renews automatically. UC San Diego may occasionally ask you to sign in again.
        </p>
      ) : account?.expiresAt ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {pending ? "Sign-in expires" : "Session expires"}{" "}
          {new Date(account.expiresAt * 1000).toLocaleString()}.
        </p>
      ) : null}
      {account?.configured ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This sign-in applies to your connection to this environment.
        </p>
      ) : null}
    </SettingsRow>
  );
}

export function UcsdAccountSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  return (
    <SettingsSection {...searchableSetting("ucsd-account")}>
      {environmentId ? (
        <AccountConnection key={environmentId} environmentId={environmentId} />
      ) : (
        <SettingsRow
          title="Account"
          description="Connect to an environment to use UC San Diego sign-in."
        />
      )}
    </SettingsSection>
  );
}
