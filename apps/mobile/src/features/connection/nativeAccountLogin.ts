import type { AccountStatus } from "@t3tools/contracts";
import { accountCallbackId } from "@t3tools/shared/accountCallback";

type Completion = { requestId: string; completionCode: string };
interface Actions {
  getStatus: () => Promise<AccountStatus>;
  start: (input: { returnUrl: string }) => Promise<AccountStatus>;
  poll: (input: Partial<Completion>) => Promise<AccountStatus>;
  signOut: () => Promise<AccountStatus>;
  createReturnUrl: () => string;
  openAuthSession: (
    url: string,
    returnUrl: string,
  ) => Promise<{ type: "success"; url: string } | { type: "cancel" | "dismiss" | "locked" }>;
}

export function readNativeAccountCompletion(
  value: string,
  returnUrl: string,
  verificationUrl: string,
): Completion {
  const callback = new URL(value);
  const base = new URL(returnUrl);
  const requestId = callback.searchParams.get("requestId") ?? "";
  const completionCode = callback.searchParams.get("completionCode") ?? "";
  if (
    !accountCallbackId(returnUrl) ||
    callback.protocol !== base.protocol ||
    callback.host !== base.host ||
    callback.pathname !== base.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    !/^[A-Za-z0-9_-]{43}$/u.test(requestId) ||
    requestId !== new URL(verificationUrl).searchParams.get("requestId") ||
    !/^[A-Za-z0-9_-]{43}$/u.test(completionCode) ||
    callback.searchParams.size !== 2 ||
    callback.searchParams.getAll("requestId").length !== 1 ||
    callback.searchParams.getAll("completionCode").length !== 1
  )
    throw new Error("This sign-in callback does not belong to this app.");
  return { requestId, completionCode };
}

export function createNativeAccountLoginState() {
  return {
    generation: 0,
    returnUrl: null as string | null,
    completion: null as Completion | null,
    browserOpen: false,
    expiresAt: 0,
  };
}

/** Memory belongs to one environment; backend callback ownership binds it to the client session. */
export function createNativeAccountLogin(
  actions: Actions,
  state = createNativeAccountLoginState(),
) {
  const clearProof = () => {
    state.completion = null;
    state.expiresAt = 0;
  };

  const poll = async (account: AccountStatus): Promise<AccountStatus> => {
    const request = state.generation;
    if (state.expiresAt <= Date.now()) clearProof();
    const next = await actions.poll(
      account.returnUrl === state.returnUrl &&
        state.completion?.requestId ===
          new URL(account.verificationUrl ?? "https://invalid").searchParams.get("requestId")
        ? state.completion
        : {},
    );
    if (request === state.generation && next.status !== "pending") clearProof();
    return next;
  };
  return {
    getStatus: async () => {
      let request = state.generation;
      const account = await actions.getStatus();
      if (
        request === state.generation &&
        (account.status !== "pending" ||
          (state.returnUrl !== null && account.returnUrl !== state.returnUrl))
      ) {
        request = ++state.generation;
        state.returnUrl = null;
        clearProof();
      }
      if (
        request === state.generation &&
        state.returnUrl === null &&
        account.status === "pending" &&
        account.returnUrl &&
        accountCallbackId(account.returnUrl)
      ) {
        const destination = actions.createReturnUrl();
        if (
          accountCallbackId(destination) &&
          new URL(account.returnUrl).protocol === new URL(destination).protocol
        ) {
          // Restore only a destination owned by this backend client session and app variant.
          state.returnUrl = account.returnUrl;
        }
      }
      return request === state.generation &&
        account.status === "pending" &&
        account.returnUrl === state.returnUrl &&
        state.completion
        ? poll(account)
        : account;
    },
    start: async () => {
      const request = ++state.generation;
      clearProof();
      const destination = actions.createReturnUrl();
      if (!accountCallbackId(destination)) throw new Error("Invalid app sign-in callback.");
      state.returnUrl = destination;
      const account = await actions.start({ returnUrl: destination });
      if (
        request === state.generation &&
        account.status === "pending" &&
        account.returnUrl !== destination
      )
        throw new Error("Cancel the previous sign-in and try again.");
      return account;
    },
    poll,
    signOut: async () => {
      state.generation++;
      state.returnUrl = null;
      clearProof();
      return actions.signOut();
    },
    openExternal: async (url: string) => {
      if (!state.returnUrl) throw new Error("Start a new sign-in in this app.");
      if (state.browserOpen) throw new Error("A sign-in browser is already open.");
      const request = state.generation;
      const destination = state.returnUrl;
      state.browserOpen = true;
      try {
        const result = await actions.openAuthSession(url, destination);
        if (request !== state.generation || result.type !== "success") return;
        state.completion = readNativeAccountCompletion(result.url, destination, url);
        state.expiresAt = Date.now() + 10 * 60 * 1000;
      } finally {
        state.browserOpen = false;
      }
    },
  };
}
