import type { EnvironmentId } from "@t3tools/contracts";
import { useUcsdAccount } from "../../hooks/useUcsdAccount";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function AccountConnection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { account, busy, error, checkedAt, controller } = useUcsdAccount(environmentId);

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
