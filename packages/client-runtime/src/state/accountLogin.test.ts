// @effect-diagnostics globalTimers:off -- Fake timers model the injected browser/mobile scheduler.
import type { AccountStatus } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createAccountLoginController } from "./accountLogin.ts";

const signedOut: AccountStatus = {
  configured: true,
  status: "signed-out",
  serviceUrl: "https://accounts.example.edu",
  profile: null,
  expiresAt: null,
  verificationUrl: null,
  userCode: null,
  pollIntervalSeconds: null,
};
const pending: AccountStatus = {
  ...signedOut,
  status: "pending",
  verificationUrl: "https://accounts.example.edu/login?requestId=example",
  userCode: "TEST-CODE",
  expiresAt: 1_800_000_600,
  pollIntervalSeconds: 5,
};
const signedIn: AccountStatus = {
  ...signedOut,
  status: "signed-in",
  profile: {
    issuer: "https://sso.example.edu",
    subject: "user-1",
    email: "example@ucsd.edu",
    displayName: "Example User",
  },
  expiresAt: 1_800_003_600,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const actions = {
    getStatus: vi.fn(async () => signedOut),
    start: vi.fn(async () => pending),
    poll: vi.fn(async () => pending),
    signOut: vi.fn(async () => signedOut),
    openExternal: vi.fn(async (_url: string) => undefined),
    now: Date.now,
    schedule: (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  };
  return { actions, controller: createAccountLoginController(actions) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("UC San Diego account login lifecycle", () => {
  it("opens the browser after starting and polls only while authorization is pending", async () => {
    const { actions, controller } = setup();
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actions.poll).not.toHaveBeenCalled();

    await controller.signIn();
    expect(actions.openExternal).toHaveBeenCalledWith(pending.verificationUrl);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(actions.poll).not.toHaveBeenCalled();
    actions.poll.mockResolvedValueOnce(signedIn);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getSnapshot().account).toEqual(signedIn);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actions.poll).toHaveBeenCalledTimes(1);
    deactivate();
  });

  it("does a new server check each time rather than reporting cached verification", async () => {
    const { actions, controller } = setup();
    actions.getStatus.mockResolvedValue(signedIn);
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    const firstCheck = controller.getSnapshot().checkedAt;
    await vi.advanceTimersByTimeAsync(1_000);
    await controller.check();
    expect(actions.getStatus).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().checkedAt).toBeGreaterThan(firstCheck!);
    actions.getStatus.mockRejectedValueOnce(new Error("Account service is unavailable."));
    await controller.check();
    expect(controller.getSnapshot().error).toBe("Account service is unavailable.");
    expect(controller.getSnapshot().busy).toBe(false);
    deactivate();
  });

  it("ignores an in-flight sign-in after the environment panel is removed", async () => {
    const { actions, controller } = setup();
    const response = deferred<AccountStatus>();
    actions.start.mockReturnValueOnce(response.promise);
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    const login = controller.signIn();
    deactivate();
    response.resolve(pending);
    await login;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(actions.openExternal).not.toHaveBeenCalled();
    expect(actions.poll).not.toHaveBeenCalled();
    expect(controller.getSnapshot().account).toBeNull();
  });

  it("does not let an older pending poll overwrite cancellation", async () => {
    const { actions, controller } = setup();
    const response = deferred<AccountStatus>();
    actions.poll.mockReturnValueOnce(response.promise);
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    await controller.signIn();
    await vi.advanceTimersByTimeAsync(5_000);
    await controller.signOut();
    response.resolve(signedIn);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().account).toEqual(signedOut);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(actions.poll).toHaveBeenCalledTimes(1);
    deactivate();
  });

  it("keeps the existing account visible when server revocation fails", async () => {
    const { actions, controller } = setup();
    actions.getStatus.mockResolvedValue(signedIn);
    actions.signOut.mockRejectedValueOnce(new Error("Revocation failed. Try again."));
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    await controller.signOut();
    expect(controller.getSnapshot().account).toEqual(signedIn);
    expect(controller.getSnapshot().error).toBe("Revocation failed. Try again.");
    await controller.signOut();
    expect(controller.getSnapshot().account).toEqual(signedOut);
    deactivate();
  });

  it("allows reopening a browser without starting another authorization", async () => {
    const { actions, controller } = setup();
    actions.openExternal.mockRejectedValueOnce(new Error("Browser unavailable"));
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    await controller.signIn();
    expect(controller.getSnapshot().account?.status).toBe("pending");
    expect(controller.getSnapshot().error).toContain("Reopen browser");
    await controller.reopenBrowser();
    expect(actions.openExternal).toHaveBeenCalledTimes(2);
    expect(actions.start).toHaveBeenCalledTimes(1);
    deactivate();
  });

  it("allows the server-approved loopback fixture but rejects an HTTP sign-in on another origin", async () => {
    const { actions, controller } = setup();
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    actions.start.mockResolvedValueOnce({
      ...pending,
      serviceUrl: "http://127.0.0.1:4318",
      verificationUrl: "http://127.0.0.1:4318/login?requestId=fixture",
    });
    await controller.signIn();
    expect(actions.openExternal).toHaveBeenCalledWith(
      "http://127.0.0.1:4318/login?requestId=fixture",
    );
    await controller.signOut();
    actions.start.mockResolvedValueOnce({
      ...pending,
      serviceUrl: "http://127.0.0.1:4318",
      verificationUrl: "http://127.0.0.1:4319/login?requestId=fixture",
    });
    await controller.signIn();
    expect(actions.openExternal).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().error).toContain("Could not open");
    await controller.signOut();
    actions.start.mockResolvedValueOnce({
      ...pending,
      verificationUrl: "https://unrelated.example.edu/login?requestId=fixture",
    });
    await controller.signIn();
    expect(actions.openExternal).toHaveBeenCalledTimes(1);
    deactivate();
  });

  it("stops at code expiry and never polls after a polling failure", async () => {
    const { actions, controller } = setup();
    actions.start.mockResolvedValueOnce({ ...pending, expiresAt: 1_800_000_002 });
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    await controller.signIn();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.getSnapshot().error).toContain("expired");
    expect(actions.poll).not.toHaveBeenCalled();

    await controller.signOut();
    await controller.signIn();
    actions.poll.mockRejectedValueOnce(new Error("Service unavailable"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(actions.poll).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().error).toBe("Service unavailable");
    deactivate();
  });

  it("can reactivate after React Strict Mode cleanup without applying the previous check", async () => {
    const { actions, controller } = setup();
    const oldStatus = deferred<AccountStatus>();
    actions.getStatus.mockReturnValueOnce(oldStatus.promise);
    controller.activate()();
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    oldStatus.resolve(signedIn);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().account).toEqual(signedOut);
    deactivate();
  });
});

describe("automatic account renewal", () => {
  it("checks before expiry, retries a transient failure, and cancels renewal when the panel closes", async () => {
    const { actions, controller } = setup();
    const renewable = { ...signedIn, renewalExpiresAt: 1_802_592_000 };
    actions.getStatus.mockResolvedValue(renewable);
    const deactivate = controller.activate();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_359_999);
    expect(actions.getStatus).toHaveBeenCalledTimes(1);
    actions.getStatus.mockRejectedValueOnce(new Error("Temporarily unavailable"));
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getSnapshot().error).toBe("Temporarily unavailable");
    actions.getStatus.mockResolvedValue({ ...renewable, expiresAt: 1_800_007_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(actions.getStatus).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().error).toBeNull();
    expect(actions.openExternal).not.toHaveBeenCalled();
    deactivate();
    await vi.advanceTimersByTimeAsync(4_000_000);
    expect(actions.getStatus).toHaveBeenCalledTimes(3);
  });
});

it("retries an offline initial check without opening a browser", async () => {
  const { actions, controller } = setup();
  actions.getStatus.mockRejectedValueOnce(new Error("Offline"));
  const deactivate = controller.activate();
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().account).toBeNull();
  actions.getStatus.mockResolvedValue({ ...signedIn, renewalExpiresAt: 1_802_592_000 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(controller.getSnapshot().account?.status).toBe("signed-in");
  expect(actions.openExternal).not.toHaveBeenCalled();
  deactivate();
});
