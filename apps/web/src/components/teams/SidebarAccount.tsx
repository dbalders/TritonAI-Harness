import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { useUcsdAccount } from "../../hooks/useUcsdAccount";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export function SidebarAccount() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? <Account key={environmentId} environmentId={environmentId} /> : null;
}

function Account({ environmentId }: { environmentId: EnvironmentId }) {
  const { account, busy, error, controller } = useUcsdAccount(environmentId);
  const profile = account?.status === "signed-in" ? account.profile : null;
  if (profile) {
    const initials = profile.displayName
      .split(/[\s,]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase();
    return (
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              className="w-full justify-start"
              aria-label={`Account: ${profile.displayName}`}
            />
          }
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {initials || "UC"}
          </span>
          <span className="min-w-0 truncate text-xs">{profile.displayName}</span>
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          <MenuItem render={<Link to="/teams" />}>Teams</MenuItem>
          <MenuItem render={<Link to="/settings/general" hash="ucsd-account" />}>
            Account settings
          </MenuItem>
          <MenuItem disabled={busy} onClick={() => void controller.signOut()}>
            Sign out
          </MenuItem>
        </MenuPopup>
      </Menu>
    );
  }
  return (
    <div className="px-1 py-1">
      <Button
        variant="ghost"
        size="xs"
        className="w-full justify-start"
        disabled={busy || !account?.configured}
        onClick={() =>
          void (account?.status === "pending" ? controller.reopenBrowser() : controller.signIn())
        }
      >
        {account?.status === "pending" ? "Finish UCSD sign-in" : "Sign in with UC San Diego"}
      </Button>
      {account?.status === "pending" ? (
        <div className="px-2 text-xs text-muted-foreground">
          {account.userCode ? (
            <p>
              Confirm code <strong className="font-mono">{account.userCode}</strong>
            </p>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => void controller.signOut()}>
            Cancel
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
