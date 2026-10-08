import type { AccountStatus } from "@t3tools/contracts";
import { squashAtomCommandFailure, type AtomCommandResult } from "./runtime.ts";

export function accountCommandValue(
  result: AtomCommandResult<AccountStatus, unknown>,
): AccountStatus {
  if (result._tag === "Success") return result.value;
  const failure = squashAtomCommandFailure(result);
  throw new Error(
    failure instanceof Error ? failure.message : "Could not connect to your account.",
  );
}

export interface AccountLoginState {
  readonly account: AccountStatus | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly checkedAt: number | null;
}

interface AccountLoginActions {
  readonly getStatus: () => Promise<AccountStatus>;
  readonly start: () => Promise<AccountStatus>;
  readonly poll: (account: AccountStatus) => Promise<AccountStatus>;
  readonly signOut: (account: AccountStatus | null) => Promise<AccountStatus>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

/** One controller belongs to one environment/client session and only lives while its panel is open. */
export function createAccountLoginController(actions: AccountLoginActions) {
  let state: AccountLoginState = { account: null, busy: false, error: null, checkedAt: null };
  const listeners = new Set<() => void>();
  let active = false;
  let generation = 0;
  let cancelTimer: (() => void) | undefined;
  let pendingDeadline = 0;

  const publish = (update: Partial<AccountLoginState>) => {
    state = { ...state, ...update };
    for (const listener of listeners) listener();
  };
  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = undefined;
  };
  const current = (request: number) => active && generation === request;
  const fail = (error: unknown) => {
    publish({
      busy: false,
      error: error instanceof Error ? error.message : "Could not connect to your account.",
    });
  };

  const scheduleRenewal = (account: AccountStatus, request: number, retry = false) => {
    clearTimer();
    if (!current(request) || account.status !== "signed-in" || !account.renewalExpiresAt) return;
    const delay = retry
      ? 60_000
      : Math.max(60_000, (account.expiresAt ?? 0) * 1000 - actions.now() - 240_000);
    cancelTimer = actions.schedule(() => {
      if (current(request)) void run("check");
    }, delay);
  };

  const schedulePoll = (account: AccountStatus, request: number) => {
    clearTimer();
    if (!current(request)) return;
    if (account.status !== "pending") {
      scheduleRenewal(account, request);
      return;
    }
    const deadline = Math.min(
      account.expiresAt === null ? Infinity : account.expiresAt * 1000,
      pendingDeadline,
    );
    const remaining = deadline - actions.now();
    if (remaining <= 0) {
      publish({ error: "The sign-in request expired. Cancel and try again." });
      return;
    }
    const interval = Math.min(30, Math.max(1, account.pollIntervalSeconds ?? 5)) * 1000;
    cancelTimer = actions.schedule(
      async () => {
        if (!current(request)) return;
        if (actions.now() >= deadline) {
          publish({ error: "The sign-in request expired. Cancel and try again." });
          return;
        }
        try {
          const next = await actions.poll(account);
          if (!current(request)) return;
          publish({ account: next, error: null });
          schedulePoll(next, request);
        } catch (error) {
          if (current(request)) fail(error);
        }
      },
      Math.min(interval, remaining),
    );
  };

  const openBrowser = async (url: string, request: number) => {
    try {
      const target = new URL(url);
      const serviceOrigin = state.account?.serviceUrl
        ? new URL(state.account.serviceUrl).origin
        : null;
      // HTTP is reserved for the server's explicitly enabled local development fixture.
      const localFixture =
        target.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
      if (
        (target.protocol !== "https:" && !localFixture) ||
        target.origin !== serviceOrigin ||
        target.pathname !== "/login" ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new Error("Invalid sign-in address.");
      await actions.openExternal(url);
      if (
        current(request) &&
        state.error === "Could not open the sign-in page. Use Reopen browser to try again."
      ) {
        publish({ error: null });
      }
    } catch {
      if (current(request)) {
        publish({ error: "Could not open the sign-in page. Use Reopen browser to try again." });
      }
    }
  };

  const run = async (kind: "check" | "start" | "signOut") => {
    if (!active || state.busy) return;
    clearTimer();
    const request = ++generation;
    publish({ busy: true, error: null });
    try {
      const account = await (kind === "check"
        ? actions.getStatus()
        : kind === "start"
          ? actions.start()
          : actions.signOut(state.account));
      if (!current(request)) return;
      publish({
        account,
        busy: false,
        checkedAt: kind === "check" && account.status === "signed-in" ? actions.now() : null,
      });
      pendingDeadline = actions.now() + 10 * 60 * 1000;
      schedulePoll(account, request);
      if (kind === "start" && account.status === "pending" && account.verificationUrl) {
        await openBrowser(account.verificationUrl, request);
      }
    } catch (error) {
      if (current(request)) {
        fail(error);
        if (kind === "check") {
          if (state.account) scheduleRenewal(state.account, request, true);
          else
            cancelTimer = actions.schedule(() => {
              if (current(request)) void run("check");
            }, 60_000);
        }
      }
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate: () => {
      active = true;
      publish({ account: null, busy: false, error: null, checkedAt: null });
      void run("check");
      return () => {
        active = false;
        generation++;
        clearTimer();
        publish({ account: null, busy: false, error: null, checkedAt: null });
      };
    },
    check: () => run("check"),
    signIn: () => run("start"),
    signOut: () => run("signOut"),
    reopenBrowser: async () => {
      if (active && state.account?.status === "pending" && state.account.verificationUrl) {
        await openBrowser(state.account.verificationUrl, generation);
      }
    },
  };
}
