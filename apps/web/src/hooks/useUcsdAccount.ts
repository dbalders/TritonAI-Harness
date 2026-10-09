import {
  accountCommandValue,
  type AccountLoginState,
  createAccountLoginController,
} from "@t3tools/client-runtime/state/server";
import type { EnvironmentId } from "@t3tools/contracts";
import { accountCallbackId } from "@t3tools/shared/accountCallback";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { reconcileDraftTeamMemoryAccount } from "../components/teams/teamMemoryDrafts";
import { toastManager } from "../components/ui/toast";
import { ensureLocalApi } from "../localApi";
import { serverEnvironment } from "../state/server";
import { usePreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
export function useUcsdAccount(environmentId: EnvironmentId): AccountLoginState & {
  controller: ReturnType<typeof createAccountLoginController>;
} {
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
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    if (preparedConnection._tag === "None") return;
    return controller.activate();
  }, [controller, preparedConnection]);
  useEffect(() => {
    const checkOnReturn = () => {
      void controller.check();
    };
    window.addEventListener("focus", checkOnReturn);
    window.addEventListener("tritonai-account-changed", checkOnReturn);
    return () => {
      window.removeEventListener("focus", checkOnReturn);
      window.removeEventListener("tritonai-account-changed", checkOnReturn);
    };
  }, [controller]);

  const accountStatus = state.account?.status;
  const identity = state.account?.profile
    ? `${state.account.profile.issuer}:${state.account.profile.subject}`
    : null;
  useEffect(() => {
    window.dispatchEvent(new Event("tritonai-account-changed"));
    if (accountStatus === undefined) return;
    // Unsent team memory belongs to the account that added it; sign-out or a switch removes it.
    const { removed, unresolved } = reconcileDraftTeamMemoryAccount(
      environmentId,
      accountStatus === "signed-in" ? identity : null,
    );
    if (unresolved > 0)
      toastManager.add({
        type: "warning",
        title: "Some team memory is still in your drafts",
        description: `Your campus account changed. In ${unresolved === 1 ? "one draft" : `${unresolved} drafts`}, the team memory was edited and Harness can’t tell where it ends, so it was left in place and marked. Delete it before sending.`,
      });
    else if (removed > 0)
      toastManager.add({
        type: "info",
        title: "Team memory removed from unsent drafts",
        description: "Your campus account changed. The rest of each draft was kept.",
      });
  }, [accountStatus, environmentId, identity]);
  return { ...state, controller };
}
