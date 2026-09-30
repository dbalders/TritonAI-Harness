#!/usr/bin/env node
// Summarizes per-install usage from Plausible's Stats API. The dashboard cannot count
// distinct install IDs (`aid`), so this groups by them and counts the groups.
//
//   PLAUSIBLE_API_KEY=... node scripts/analytics-report.ts --period 30d

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

const PAGE_SIZE = 10_000;
// Plausible reports a missing custom prop as "(none)"; older releases send no `aid`.
const MISSING_PROP = "(none)";

const QueryResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      dimensions: Schema.Array(Schema.String),
      metrics: Schema.Array(Schema.Number),
    }),
  ),
});
type QueryRow = (typeof QueryResponse.Type)["results"][number];

export interface ReportRows {
  /** [aid] with event counts across all events in the period. */
  readonly seen: ReadonlyArray<QueryRow>;
  /** [aid] for `client.turn.requested` in the period. */
  readonly active: ReadonlyArray<QueryRow>;
  /** [aid] with `thread.created` counts in the period. */
  readonly threadsCreated: ReadonlyArray<QueryRow>;
  /** [aid, threadCount, firstThreadMonth] from `server.boot.heartbeat`, all time. */
  readonly heartbeats: ReadonlyArray<QueryRow>;
}

export interface UsageReport {
  readonly installsSeen: number;
  readonly activeInstalls: number;
  readonly threadsCreated: { readonly total: number; readonly installs: number };
  readonly threadsCreatedPerInstall: Distribution;
  readonly lifetimeThreadsPerInstall: Distribution;
  /** Installs by the month of their first thread; includes use from before tracking began. */
  readonly installsByFirstThreadMonth: ReadonlyArray<readonly [month: string, installs: number]>;
}

export interface Distribution {
  readonly median: number;
  readonly p90: number;
  readonly max: number;
}

const withInstallId = (rows: ReadonlyArray<QueryRow>) =>
  rows.filter((row) => row.dimensions[0] !== undefined && row.dimensions[0] !== MISSING_PROP);

function distribution(values: ReadonlyArray<number>): Distribution {
  if (values.length === 0) return { median: 0, p90: 0, max: 0 };
  const sorted = [...values].toSorted((a, b) => a - b);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
  return { median: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? 0 };
}

export function summarizeUsage(rows: ReportRows): UsageReport {
  const threadsCreated = withInstallId(rows.threadsCreated).map((row) => row.metrics[0] ?? 0);

  // Heartbeat thread counts include deleted threads, so the largest value is the latest.
  const lifetimeThreads = new Map<string, number>();
  const firstMonth = new Map<string, string>();
  for (const row of withInstallId(rows.heartbeats)) {
    const [aid = "", rawThreadCount = "", month = ""] = row.dimensions;
    const threadCount = Number(rawThreadCount);
    if (Number.isFinite(threadCount)) {
      lifetimeThreads.set(aid, Math.max(lifetimeThreads.get(aid) ?? 0, threadCount));
    }
    if (/^\d{4}-\d{2}$/.test(month) && month < (firstMonth.get(aid) ?? "9999-99")) {
      firstMonth.set(aid, month);
    }
  }
  const installsByMonth = new Map<string, number>();
  for (const month of firstMonth.values()) {
    installsByMonth.set(month, (installsByMonth.get(month) ?? 0) + 1);
  }

  return {
    installsSeen: withInstallId(rows.seen).length,
    activeInstalls: withInstallId(rows.active).length,
    threadsCreated: {
      total: threadsCreated.reduce((sum, count) => sum + count, 0),
      installs: threadsCreated.length,
    },
    threadsCreatedPerInstall: distribution(threadsCreated),
    lifetimeThreadsPerInstall: distribution([...lifetimeThreads.values()]),
    installsByFirstThreadMonth: [...installsByMonth].toSorted(([a], [b]) => a.localeCompare(b)),
  };
}

export function formatUsageReport(period: string, report: UsageReport): string {
  const spread = (d: Distribution) => `median ${d.median}, p90 ${d.p90}, max ${d.max}`;
  return [
    `Installs seen (${period}): ${report.installsSeen}`,
    `Active installs, requested a turn (${period}): ${report.activeInstalls}`,
    `Threads created (${period}): ${report.threadsCreated.total} by ${report.threadsCreated.installs} installs`,
    `Threads created per install (${period}): ${spread(report.threadsCreatedPerInstall)}`,
    `Lifetime threads per install: ${spread(report.lifetimeThreadsPerInstall)}`,
    "Installs by first-thread month:",
    ...report.installsByFirstThreadMonth.map(([month, installs]) => `  ${month}: ${installs}`),
  ].join("\n");
}

const PlausibleConfig = Config.all({
  apiKey: Config.redacted("PLAUSIBLE_API_KEY"),
  baseUrl: Config.string("PLAUSIBLE_URL").pipe(
    Config.withDefault("https://tritonai-analytics.ucsd.edu"),
  ),
  siteId: Config.string("PLAUSIBLE_SITE_ID").pipe(Config.withDefault("tritonai-harness")),
});

const makeQuery = Effect.fn("analyticsReport.makeQuery")(function* () {
  const config = yield* PlausibleConfig;
  const httpClient = yield* HttpClient.HttpClient;

  return Effect.fn("analyticsReport.query")(function* (input: {
    readonly dateRange: string;
    readonly dimensions: ReadonlyArray<string>;
    readonly goal?: string;
  }) {
    const rows: Array<QueryRow> = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const response = yield* HttpClientRequest.post(`${config.baseUrl}/api/v2/query`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(config.apiKey)),
        HttpClientRequest.bodyJson({
          site_id: config.siteId,
          metrics: ["events"],
          date_range: input.dateRange,
          dimensions: input.dimensions,
          ...(input.goal ? { filters: [["is", "event:goal", [input.goal]]] } : {}),
          pagination: { limit: PAGE_SIZE, offset },
        }),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(QueryResponse)),
      );
      rows.push(...response.results);
      if (response.results.length < PAGE_SIZE) return rows;
    }
  });
});

export const analyticsReportCommand = Command.make(
  "analytics-report",
  {
    period: Flag.string("period").pipe(
      Flag.withDefault("30d"),
      Flag.withDescription("Plausible date range for activity, e.g. 7d, 30d, month, 12mo."),
    ),
  },
  ({ period }) =>
    Effect.gen(function* () {
      const query = yield* makeQuery();
      const aid = "event:props:aid";
      const [seen, active, threadsCreated, heartbeats] = yield* Effect.all(
        [
          query({ dateRange: period, dimensions: [aid] }),
          query({ dateRange: period, dimensions: [aid], goal: "client.turn.requested" }),
          query({ dateRange: period, dimensions: [aid], goal: "thread.created" }),
          query({
            dateRange: "all",
            dimensions: [aid, "event:props:threadCount", "event:props:firstThreadMonth"],
            goal: "server.boot.heartbeat",
          }),
        ],
        { concurrency: 2 },
      );
      const report = summarizeUsage({ seen, active, threadsCreated, heartbeats });
      yield* Effect.log(formatUsageReport(period, report));
    }),
).pipe(Command.withDescription("Count installs and threads per install from Plausible."));

if (import.meta.main) {
  Command.run(analyticsReportCommand, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
