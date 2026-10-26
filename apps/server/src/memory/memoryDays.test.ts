// @effect-diagnostics globalDate:off - the helpers under test use host-local days.
import { describe, expect, it } from "vite-plus/test";

import { addLocalDays, isLocalDay } from "./memoryDays.ts";

describe("local days", () => {
  it("rejects values that are not real days", () => {
    expect(isLocalDay("2026-09-28")).toBe(true);
    expect(isLocalDay("2026-02-30")).toBe(false);
    expect(isLocalDay("yesterday")).toBe(false);
    expect(addLocalDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});
