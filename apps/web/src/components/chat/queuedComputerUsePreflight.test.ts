import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { assertQueuedComputerUseReady } from "./queuedComputerUsePreflight";

const ready = {
  enabled: true,
  available: true,
  running: true,
  accessibilityPermission: true,
  screenRecordingPermission: true,
};
const input = {
  prompt: "/computer-use inspect the desktop",
  provider: ProviderDriverKind.make("codex"),
  localDesktop: true,
  usesWsl: false,
  readState: async () => ready,
};

describe("queued computer-use dispatch preflight", () => {
  it("checks current readiness after a previously ordinary message is edited", async () => {
    const readState = vi.fn(async () => ({ ...ready, available: false }));
    await assertQueuedComputerUseReady({ ...input, prompt: "ordinary message", readState });
    expect(readState).not.toHaveBeenCalled();
    await expect(assertQueuedComputerUseReady({ ...input, readState })).rejects.toThrow(
      "Computer use",
    );
    expect(readState).toHaveBeenCalledOnce();
  });
  it("rejects revoked permissions, WSL, and unsupported providers", async () => {
    await expect(
      assertQueuedComputerUseReady({
        ...input,
        readState: async () => ({ ...ready, screenRecordingPermission: false }),
      }),
    ).rejects.toThrow("permissions");
    await expect(assertQueuedComputerUseReady({ ...input, usesWsl: true })).rejects.toThrow(
      "native desktop",
    );
    await expect(
      assertQueuedComputerUseReady({ ...input, provider: ProviderDriverKind.make("claudeAgent") }),
    ).rejects.toThrow("Codex");
  });
  it("does not apply this desktop's permissions to a remote target", async () => {
    const readState = vi.fn(async () => ready);
    await assertQueuedComputerUseReady({ ...input, localDesktop: false, readState });
    expect(readState).not.toHaveBeenCalled();
  });
  it("allows ready requests but asks for an objective for a bare command", async () => {
    await assertQueuedComputerUseReady(input);
    await expect(
      assertQueuedComputerUseReady({ ...input, prompt: "/computer-use" }),
    ).rejects.toThrow("Add what");
  });
});
