import { assert, it } from "@effect/vitest";

import { formatUsageReport, summarizeUsage } from "./analytics-report.ts";

const row = (dimensions: ReadonlyArray<string>, events = 1) => ({ dimensions, metrics: [events] });

it("counts distinct installs and ignores events from releases without an install ID", () => {
  const report = summarizeUsage({
    seen: [row(["a"], 40), row(["b"], 3), row(["(none)"], 900)],
    active: [row(["a"], 12), row(["(none)"], 50)],
    threadsCreated: [row(["a"], 5), row(["b"], 1), row(["(none)"], 30)],
    heartbeats: [],
  });

  assert.equal(report.installsSeen, 2);
  assert.equal(report.activeInstalls, 1);
  assert.deepEqual(report.threadsCreated, { total: 6, installs: 2 });
  assert.deepEqual(report.threadsCreatedPerInstall, { median: 5, p90: 5, max: 5 });
});

it("uses each install's latest lifetime thread count and earliest first-thread month", () => {
  const report = summarizeUsage({
    seen: [],
    active: [],
    threadsCreated: [],
    heartbeats: [
      row(["a", "10", "2026-03"]),
      row(["a", "26", "2026-03"]),
      row(["b", "2", "2026-09"]),
      row(["c", "0", "(none)"]),
      row(["(none)", "400", "2025-01"]),
    ],
  });

  assert.deepEqual(report.lifetimeThreadsPerInstall, { median: 2, p90: 26, max: 26 });
  assert.deepEqual(report.installsByFirstThreadMonth, [
    ["2026-03", 1],
    ["2026-09", 1],
  ]);
});

it("formats the report for reading", () => {
  const text = formatUsageReport(
    "30d",
    summarizeUsage({
      seen: [row(["a"])],
      active: [row(["a"])],
      threadsCreated: [row(["a"], 4)],
      heartbeats: [row(["a", "12", "2026-05"])],
    }),
  );

  assert.include(text, "Installs seen (30d): 1");
  assert.include(text, "Threads created (30d): 4 by 1 installs");
  assert.include(text, "  2026-05: 1");
});
