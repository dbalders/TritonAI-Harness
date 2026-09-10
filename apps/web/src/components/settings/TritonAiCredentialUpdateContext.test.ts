import type { DesktopTritonAiCredentialsUpdateResult } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void | (() => void), deps: ReadonlyArray<unknown>) => {
      const previous = reactHookHarness.useRef<{
        deps: ReadonlyArray<unknown>;
        cleanup: void | (() => void);
      } | null>(null);
      if (previous.current?.deps.every((value, index) => Object.is(value, deps[index]))) return;
      previous.current?.cleanup?.();
      previous.current = { deps, cleanup: effect() };
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/environments", () => ({ usePrimaryEnvironment: () => null }));

import { useTritonAiCredentialUpdate } from "./TritonAiCredentialUpdateContext";

const saved: DesktopTritonAiCredentialsUpdateResult = {
  status: "saved",
  credentials: {
    ready: true,
    usesSharedKey: true,
    onPremConfigured: true,
    frontierConfigured: true,
    onPremKeyLastFour: "1234",
    frontierKeyLastFour: "1234",
  },
};

function render(update: Parameters<typeof useTritonAiCredentialUpdate>[0], connected: boolean) {
  hooks.beginRender();
  return useTritonAiCredentialUpdate(update, connected);
}

describe("TritonAI credential reconnect", () => {
  beforeEach(() => {
    hooks.reset();
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits through the backend restart and client reconnect before clearing progress", async () => {
    let resolveResponse!: (result: DesktopTritonAiCredentialsUpdateResult) => void;
    const response = new Promise<DesktopTritonAiCredentialsUpdateResult>((resolve) => {
      resolveResponse = resolve;
    });
    const update = vi.fn(() => response);
    const operation = render(update, true).updateCredentials({
      route: "on-prem",
      apiKey: "test-1234",
    });
    expect(render(update, false).phase).toBe("saving");

    resolveResponse(saved);
    await operation;
    expect(render(update, false).phase).toBe("reconnecting");
    vi.advanceTimersByTime(9_000);
    expect(render(update, false).phase).toBe("reconnecting");

    render(update, true);
    expect(render(update, true).phase).toBe("idle");
    vi.advanceTimersByTime(20_000);
    expect(render(update, true).phase).toBe("idle");
  });

  it("surfaces a prolonged reconnect and recovers when the client eventually connects", async () => {
    const update = vi.fn(async () => saved);
    await render(update, true).updateCredentials({ route: "frontier", remove: true });
    render(update, false);
    vi.advanceTimersByTime(10_000);
    expect(render(update, false).phase).toBe("timed-out");
    render(update, true);
    expect(render(update, true).phase).toBe("idle");
  });

  it("does not hide a rejected key behind a reconnect wait", async () => {
    const rejected = { status: "error", message: "Key rejected" } as const;
    const update = vi.fn(async () => rejected);
    const result = await render(update, true).updateCredentials({
      route: "on-prem",
      apiKey: "bad-key",
    });
    expect(result).toEqual(rejected);
    expect(render(update, true).phase).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears progress when the desktop request fails", async () => {
    const update = vi.fn(async () => {
      throw new Error("IPC failed");
    });
    await expect(
      render(update, true).updateCredentials({ route: "on-prem", apiKey: "test-key" }),
    ).rejects.toThrow("IPC failed");
    expect(render(update, true).phase).toBe("idle");
  });
});
