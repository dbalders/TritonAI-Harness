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

/** Callback proof stays in the initiating environment's controller, never in navigation or storage. */
export function createNativeAccountLogin(actions: Actions) {
  let generation = 0;
  let returnUrl: string | null = null;
  let completion: Completion | null = null;
  let browserOpen = false;

  const poll = async (account: AccountStatus): Promise<AccountStatus> => {
    const request = generation;
    const next = await actions.poll(
      account.returnUrl === returnUrl && completion ? completion : {},
    );
    if (request === generation && next.status !== "pending") completion = null;
    return next;
  };
  return {
    getStatus: async () => {
      const request = generation;
      const account = await actions.getStatus();
      if (
        request === generation &&
        returnUrl === null &&
        account.status === "pending" &&
        account.returnUrl &&
        accountCallbackId(account.returnUrl)
      ) {
        const destination = actions.createReturnUrl();
        if (
          accountCallbackId(destination) &&
          new URL(account.returnUrl).protocol === new URL(destination).protocol
        ) {
          // Restore the destination from this session's backend, never a saved completion proof.
          returnUrl = account.returnUrl;
        }
      }
      return request === generation &&
        account.status === "pending" &&
        account.returnUrl === returnUrl &&
        completion
        ? poll(account)
        : account;
    },
    start: async () => {
      const request = ++generation;
      completion = null;
      const destination = actions.createReturnUrl();
      if (!accountCallbackId(destination)) throw new Error("Invalid app sign-in callback.");
      returnUrl = destination;
      const account = await actions.start({ returnUrl: destination });
      if (
        request === generation &&
        account.status === "pending" &&
        account.returnUrl !== destination
      )
        throw new Error("Cancel the previous sign-in and try again.");
      return account;
    },
    poll,
    signOut: async () => {
      generation++;
      returnUrl = null;
      completion = null;
      return actions.signOut();
    },
    openExternal: async (url: string) => {
      if (!returnUrl) throw new Error("Start a new sign-in in this app.");
      if (browserOpen) throw new Error("A sign-in browser is already open.");
      const request = generation;
      const destination = returnUrl;
      browserOpen = true;
      try {
        const result = await actions.openAuthSession(url, destination);
        if (request !== generation || result.type !== "success") return;
        completion = readNativeAccountCompletion(result.url, destination, url);
      } finally {
        browserOpen = false;
      }
    },
  };
}
