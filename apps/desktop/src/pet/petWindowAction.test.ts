import { describe, expect, it } from "vite-plus/test";

import { isPetWindowAction } from "./petWindowAction.ts";

describe("isPetWindowAction", () => {
  it("accepts valid pet window actions", () => {
    expect(isPetWindowAction({ kind: "close" })).toBe(true);
    expect(isPetWindowAction({ kind: "set-pet", pet: "triton" })).toBe(true);
    expect(isPetWindowAction({ kind: "set-pet", pet: "off" })).toBe(true);
    expect(isPetWindowAction({ kind: "set-movement", movement: "static" })).toBe(true);
    expect(isPetWindowAction({ kind: "set-movement", movement: "playful" })).toBe(true);
    expect(
      isPetWindowAction({
        kind: "select-thread",
        environmentId: "environment",
        threadId: "thread",
      }),
    ).toBe(true);
  });

  it("rejects malformed and unrelated payloads", () => {
    expect(isPetWindowAction(null)).toBe(false);
    expect(isPetWindowAction({})).toBe(false);
    expect(isPetWindowAction({ kind: "set-pet", pet: "dragon" })).toBe(false);
    expect(isPetWindowAction({ kind: "set-movement", movement: "fast" })).toBe(false);
    expect(isPetWindowAction({ kind: "select-thread", environmentId: "environment" })).toBe(false);
  });
});
