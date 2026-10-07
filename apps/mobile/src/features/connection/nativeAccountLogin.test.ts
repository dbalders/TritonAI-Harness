import type { AccountStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNativeAccountLogin, readNativeAccountCompletion } from "./nativeAccountLogin";

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
  return { actions, native: createNativeAccountLogin(actions) };
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
});
