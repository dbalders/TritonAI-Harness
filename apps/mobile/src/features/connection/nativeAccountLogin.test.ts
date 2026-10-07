import type { AccountStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createNativeAccountLogin,
  createNativeAccountLoginState,
  readNativeAccountCompletion,
} from "./nativeAccountLogin";

const id = "a".repeat(43);
const proof = "p".repeat(43);
const returnUrl = `t3code-dev:///account/callback/${"c".repeat(43)}`;
const verificationUrl = `https://accounts.example.edu/login?requestId=${id}`;
const callback = `${returnUrl}?requestId=${id}&completionCode=${proof}`;
const pending: AccountStatus = {
  configured: true,
  status: "pending",
  serviceUrl: "https://accounts.example.edu",
  profile: null,
  expiresAt: 1_800_000_600,
  verificationUrl,
  userCode: null,
  pollIntervalSeconds: 2,
  returnUrl,
};
const signedOut: AccountStatus = { ...pending, status: "signed-out", returnUrl: undefined };
const signedIn: AccountStatus = { ...pending, status: "signed-in", returnUrl: undefined };

function setup() {
  const actions = {
    getStatus: vi.fn(async () => pending),
    start: vi.fn(async () => pending),
    poll: vi.fn(async (_input: { requestId?: string; completionCode?: string }) => signedIn),
    signOut: vi.fn(async () => signedOut),
    createReturnUrl: () => returnUrl,
    openAuthSession: vi.fn(
      async (
        _url: string,
        _returnUrl: string,
      ): Promise<{ type: "success"; url: string } | { type: "cancel" }> => ({
        type: "success",
        url: callback,
      }),
    ),
  };
  const state = createNativeAccountLoginState();
  return { actions, state, native: createNativeAccountLogin(actions, state) };
}

describe("native UCSD sign-in", () => {
  it("returns from system authentication and exchanges the proof without confirmation", async () => {
    const { native, actions } = setup();
    expect(await native.start()).toEqual(pending);
    expect(actions.start).toHaveBeenCalledWith({ returnUrl });
    await native.poll(pending);
    expect(actions.poll).toHaveBeenLastCalledWith({});
    await native.openExternal(verificationUrl);
    expect(actions.openAuthSession).toHaveBeenCalledWith(verificationUrl, returnUrl);
    expect(await native.getStatus()).toEqual(signedIn);
    expect(actions.poll).toHaveBeenLastCalledWith({ requestId: id, completionCode: proof });
    await native.poll(pending);
    expect(actions.poll).toHaveBeenLastCalledWith({});
  });

  it.each([
    callback.replace("t3code-dev", "t3code-preview"),
    callback.replace("c".repeat(43), "d".repeat(43)),
    callback.replace(id, "b".repeat(43)),
    callback.replace(proof, "short"),
    `${callback}&requestId=${id}`,
    `${callback}&extra=1`,
    `${callback}#fragment`,
    callback.replace("t3code-dev:///", "t3code-dev://evil/"),
  ])("rejects callbacks from another attempt or malformed callbacks", (value) => {
    expect(() => readNativeAccountCompletion(value, returnUrl, verificationUrl)).toThrow();
  });

  it("does not exchange when the system browser was cancelled", async () => {
    const { native, actions } = setup();
    actions.openAuthSession.mockResolvedValueOnce({ type: "cancel" });
    await native.start();
    await native.openExternal(verificationUrl);
    expect(await native.getStatus()).toEqual(pending);
    expect(actions.poll).not.toHaveBeenCalled();
  });

  it("ignores a late browser return after cancellation", async () => {
    const { native, actions } = setup();
    let finish!: (value: { type: "success"; url: string }) => void;
    actions.openAuthSession.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await native.start();
    const opened = native.openExternal(verificationUrl);
    await native.signOut();
    finish({ type: "success", url: callback });
    await opened;
    await native.poll(pending);
    expect(actions.poll).toHaveBeenLastCalledWith({});
  });

  it("reopens a cancelled pending browser after the settings panel remounts", async () => {
    const { native, actions } = setup();
    actions.openAuthSession.mockResolvedValueOnce({ type: "cancel" });
    await native.start();
    await native.openExternal(verificationUrl);
    const remounted = createNativeAccountLogin({
      ...actions,
      createReturnUrl: () => returnUrl.replace("c".repeat(43), "d".repeat(43)),
    });
    expect(await remounted.getStatus()).toEqual(pending);
    expect(actions.poll).not.toHaveBeenCalled();
    await remounted.openExternal(verificationUrl);
    expect(actions.openAuthSession).toHaveBeenLastCalledWith(verificationUrl, returnUrl);
    expect(await remounted.getStatus()).toEqual(signedIn);
    expect(actions.poll).toHaveBeenLastCalledWith({ requestId: id, completionCode: proof });
  });

  it.each([
    returnUrl.replace("t3code-dev", "t3code-preview"),
    returnUrl.replace("t3code-dev:///", "http://127.0.0.1:18794/"),
    `${returnUrl}?extra=1`,
  ])("does not adopt another app's callback destination on remount", async (destination) => {
    const { native, actions } = setup();
    actions.getStatus.mockResolvedValueOnce({ ...pending, returnUrl: destination });
    await native.getStatus();
    await expect(native.openExternal(verificationUrl)).rejects.toThrow("Start a new sign-in");
    expect(actions.openAuthSession).not.toHaveBeenCalled();
  });

  it("does not restore a late pending destination after cancellation", async () => {
    const { native, actions } = setup();
    let finish!: (value: AccountStatus) => void;
    actions.getStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const checking = native.getStatus();
    await native.signOut();
    finish(pending);
    await checking;
    await expect(native.openExternal(verificationUrl)).rejects.toThrow("Start a new sign-in");
    expect(actions.openAuthSession).not.toHaveBeenCalled();
  });

  it("never delivers proof to another environment's attempt", async () => {
    const { native, actions } = setup();
    await native.start();
    await native.openExternal(verificationUrl);
    await native.poll({ ...pending, returnUrl: returnUrl.replace("c".repeat(43), "d".repeat(43)) });
    expect(actions.poll).toHaveBeenLastCalledWith({});
  });

  it("keeps the callback proof available after a transient exchange failure", async () => {
    const { native, actions } = setup();
    await native.start();
    await native.openExternal(verificationUrl);
    actions.poll.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(native.getStatus()).rejects.toThrow("Disconnected");
    expect(await native.getStatus()).toEqual(signedIn);
    expect(actions.poll).toHaveBeenLastCalledWith({ requestId: id, completionCode: proof });
  });

  it.each(["status", "exchange"])(
    "retries a received proof after a transient %s failure and panel remount",
    async (failure) => {
      const { native, actions, state } = setup();
      await native.start();
      await native.openExternal(verificationUrl);
      if (failure === "status") actions.getStatus.mockRejectedValueOnce(new Error("Disconnected"));
      else actions.poll.mockRejectedValueOnce(new Error("Disconnected"));
      await expect(native.getStatus()).rejects.toThrow("Disconnected");
      const remounted = createNativeAccountLogin(actions, state);
      expect(await remounted.getStatus()).toEqual(signedIn);
      expect(actions.poll).toHaveBeenLastCalledWith({ requestId: id, completionCode: proof });
      expect(actions.openAuthSession).toHaveBeenCalledTimes(1);
      await remounted.poll(pending);
      expect(actions.poll).toHaveBeenLastCalledWith({});
    },
  );

  it("invalidates a browser opened by the previous panel when a remount cancels", async () => {
    const { native, actions, state } = setup();
    let finish!: (value: { type: "success"; url: string }) => void;
    actions.openAuthSession.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await native.start();
    const opened = native.openExternal(verificationUrl);
    await createNativeAccountLogin(actions, state).signOut();
    finish({ type: "success", url: callback });
    await opened;
    await native.poll(pending);
    expect(actions.poll).toHaveBeenLastCalledWith({});
  });

  it("discards another client session's retained proof before restoring its pending callback", async () => {
    const { native, actions, state } = setup();
    await native.start();
    await native.openExternal(verificationUrl);
    const otherPending = {
      ...pending,
      returnUrl: returnUrl.replace("c".repeat(43), "d".repeat(43)),
      verificationUrl: verificationUrl.replace(id, "b".repeat(43)),
    };
    actions.getStatus.mockResolvedValueOnce(otherPending);
    const remounted = createNativeAccountLogin(actions, state);
    expect(await remounted.getStatus()).toEqual(otherPending);
    expect(actions.poll).not.toHaveBeenCalled();
    await remounted.poll(otherPending);
    expect(actions.poll).toHaveBeenLastCalledWith({});
  });

  it("does not retain proof in another environment or beyond ten minutes", async () => {
    const { native, actions, state } = setup();
    await native.start();
    await native.openExternal(verificationUrl);
    const other = createNativeAccountLogin(actions);
    expect(await other.getStatus()).toEqual(pending);
    await other.poll(pending);
    expect(actions.poll).toHaveBeenLastCalledWith({});
    const clock = vi.spyOn(Date, "now").mockReturnValue(state.expiresAt + 1);
    try {
      await createNativeAccountLogin(actions, state).getStatus();
      expect(actions.poll).toHaveBeenLastCalledWith({});
      expect(state.completion).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});
