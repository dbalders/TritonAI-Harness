// @effect-diagnostics globalDate:off - the helpers under test use host-local days.
import { describe, expect, it } from "vite-plus/test";

import { addLocalDays, isLocalDay, localDayRange, pendingMemoryDays } from "./memoryDays.ts";

describe("pendingMemoryDays", () => {
  it("starts a week back on the first run and never includes today", () => {
    expect(
      pendingMemoryDays({ lastSummarizedDay: null, today: "2026-09-29", maxCatchUpDays: 7 }),
    ).toEqual([
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
    ]);
  });

  it("resumes after the last summarized day", () => {
    expect(
      pendingMemoryDays({
        lastSummarizedDay: "2026-09-26",
        today: "2026-09-29",
        maxCatchUpDays: 7,
      }),
    ).toEqual(["2026-09-27", "2026-09-28"]);
  });

  it("does nothing once yesterday is summarized", () => {
    expect(
      pendingMemoryDays({
        lastSummarizedDay: "2026-09-28",
        today: "2026-09-29",
        maxCatchUpDays: 7,
      }),
    ).toEqual([]);
  });

  it("caps a long gap to the catch-up window", () => {
    const days = pendingMemoryDays({
      lastSummarizedDay: "2026-06-01",
      today: "2026-09-29",
      maxCatchUpDays: 7,
    });
    expect(days[0]).toBe("2026-09-22");
    expect(days).toHaveLength(7);
  });

  it("crosses month and year boundaries", () => {
    expect(
      pendingMemoryDays({
        lastSummarizedDay: "2026-12-30",
        today: "2027-01-02",
        maxCatchUpDays: 7,
      }),
    ).toEqual(["2026-12-31", "2027-01-01"]);
  });
});

describe("local days", () => {
  it("maps a day to the UTC range between its local midnights", () => {
    const range = localDayRange("2026-09-28");
    expect(range.startIso).toBe(new Date(2026, 8, 28).toISOString());
    expect(range.endIso).toBe(new Date(2026, 8, 29).toISOString());
    const midday = new Date(2026, 8, 28, 12).toISOString();
    expect(midday >= range.startIso && midday < range.endIso).toBe(true);
  });

  it("rejects values that are not real days", () => {
    expect(isLocalDay("2026-09-28")).toBe(true);
    expect(isLocalDay("2026-02-30")).toBe(false);
    expect(isLocalDay("yesterday")).toBe(false);
    expect(addLocalDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});
