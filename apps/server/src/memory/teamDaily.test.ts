import { describe, expect, it } from "@effect/vitest";

import {
  MAX_TEAM_DAILY_BYTES,
  renderTeamDailyFile,
  type TeamDailyDay,
  type TeamDailyThreadNow,
} from "./teamDaily.ts";

const LINKED = new Map([["project", "2026-10-01T00:00:00.000Z"]]);
const section = (text: string, publishedText: string | null, startedAt: string) => ({
  projectId: "project",
  sharing: null,
  linkSince: "2026-10-01T00:00:00.000Z",
  text,
  publishedText,
  startedAt,
  fingerprint: text,
});
const block = (label: string, size: number) => `## ${label}\n\n${"x".repeat(size)}`;
const dayWith = (
  sections: TeamDailyDay["sections"],
  authorName = "Alice",
  publishedSha: string | null = "published",
): TeamDailyDay => ({
  sections,
  etag: "v1",
  publishedSha,
  status: "partial",
  summarizedAt: "2026-10-10T12:00:00.000Z",
  authorName,
  deviceLabel: "Test Mac",
  timeZone: "America/Los_Angeles",
});
const shared = (ids: ReadonlyArray<string>): ReadonlyMap<string, TeamDailyThreadNow> =>
  new Map(
    ids.map((id) => [id, { projectId: "project", deleted: false, off: false, resumedAt: null }]),
  );
const bytes = (text: string) => new TextEncoder().encode(text).length;
const header = { day: "2026-10-10", author: "a".repeat(43) };

describe("renderTeamDailyFile size budget", () => {
  it("keeps published text when a thread's newer summary or a new thread doesn't fit", () => {
    // Two published threads fill most of the day; one has grown, and a new thread arrived.
    const grownOld = block("grown", 25_000);
    const day = dayWith({
      grown: section(block("grown", 40_000), grownOld, "2026-10-10T09:00:00.000Z"),
      steady: section(block("steady", 25_000), block("steady", 25_000), "2026-10-10T10:00:00.000Z"),
      added: section(block("added", 8_000), null, "2026-10-10T11:00:00.000Z"),
    });
    const rendered = renderTeamDailyFile(day, header, {
      threads: shared(["grown", "steady", "added"]),
      linkedProjects: LINKED,
    });
    // The grown thread keeps its published text instead of disappearing.
    expect(rendered.included.get("grown")).toBe(grownOld);
    expect(rendered.included.get("steady")).toBe(block("steady", 25_000));
    expect(rendered.included.has("added")).toBe(true);
    expect(rendered.deferred).toEqual(["grown"]);
    expect(rendered.freshThreads.has("grown")).toBe(false);
    expect(rendered.text).toContain("1 more thread's latest work");
    expect(bytes(rendered.text!)).toBeLessThanOrEqual(MAX_TEAM_DAILY_BYTES);
  });

  it("still removes a thread chosen as Don't share from a full day", () => {
    const day = dayWith({
      grown: section(block("grown", 40_000), block("grown", 25_000), "2026-10-10T09:00:00.000Z"),
      withdrawn: section(
        block("withdrawn", 25_000),
        block("withdrawn", 25_000),
        "2026-10-10T10:00:00.000Z",
      ),
    });
    const threads = new Map(shared(["grown", "withdrawn"]));
    threads.set("withdrawn", { projectId: "project", deleted: false, off: true, resumedAt: null });
    const rendered = renderTeamDailyFile(day, header, { threads, linkedProjects: LINKED });
    expect(rendered.withdrawn).toEqual(["withdrawn"]);
    expect(rendered.text).not.toContain("## withdrawn");
    // With the room freed, the grown thread's newer text now fits.
    expect(rendered.included.get("grown")).toBe(block("grown", 40_000));
  });

  it("counts the whole file, including a long header, against the budget", () => {
    const longName = "Ä".repeat(3_000);
    const day = dayWith(
      {
        one: section(block("one", 28_000), null, "2026-10-10T09:00:00.000Z"),
        two: section(block("two", 28_000), null, "2026-10-10T10:00:00.000Z"),
      },
      longName,
      null,
    );
    const rendered = renderTeamDailyFile(day, header, {
      threads: shared(["one", "two"]),
      linkedProjects: LINKED,
    });
    expect(bytes(rendered.text!)).toBeLessThanOrEqual(MAX_TEAM_DAILY_BYTES);
    expect(rendered.included.has("one")).toBe(true);
    expect(rendered.deferred).toEqual(["two"]);
  });

  describe("renderTeamDailyFile eligibility", () => {
    it("drops a deleted thread's waiting text and keeps what it published", () => {
      const day = dayWith({
        deleted: section("## deleted waiting", null, "2026-10-10T09:00:00.000Z"),
        deletedPublished: section("## newer", "## published", "2026-10-10T10:00:00.000Z"),
        moved: section("## moved waiting", null, "2026-10-10T11:00:00.000Z"),
      });
      const threads = new Map<string, TeamDailyThreadNow>([
        ["deleted", { projectId: "project", deleted: true, off: false, resumedAt: null }],
        ["deletedPublished", { projectId: "project", deleted: true, off: false, resumedAt: null }],
        ["moved", { projectId: "another project", deleted: false, off: false, resumedAt: null }],
      ]);
      const rendered = renderTeamDailyFile(day, header, { threads, linkedProjects: LINKED });
      expect(rendered.dropped.toSorted()).toEqual(["deleted", "moved"]);
      expect(rendered.frozen).toEqual(["deletedPublished"]);
      expect([...rendered.included]).toEqual([["deletedPublished", "## published"]]);
      expect(rendered.freshThreads.size).toBe(0);
    });
  });

  describe("renderTeamDailyFile withdrawal of deleted threads", () => {
    it("withdraws a deleted thread's published section when it was chosen as Don't share", () => {
      const day = dayWith({
        offThenDeleted: section("## off", "## off", "2026-10-10T09:00:00.000Z"),
        resharedThenDeleted: section("## reshared", "## reshared", "2026-10-10T10:00:00.000Z"),
        deletedOnly: section("## kept", "## kept", "2026-10-10T11:00:00.000Z"),
      });
      const threads = new Map<string, TeamDailyThreadNow>([
        ["offThenDeleted", { projectId: "project", deleted: true, off: true, resumedAt: null }],
        [
          "resharedThenDeleted",
          {
            projectId: "project",
            deleted: true,
            off: false,
            resumedAt: "2026-10-10T12:00:00.000Z",
          },
        ],
        ["deletedOnly", { projectId: "project", deleted: true, off: false, resumedAt: null }],
      ]);
      const rendered = renderTeamDailyFile(day, header, { threads, linkedProjects: LINKED });
      expect(rendered.withdrawn.toSorted()).toEqual(["offThenDeleted", "resharedThenDeleted"]);
      expect([...rendered.included.keys()]).toEqual(["deletedOnly"]);
    });
  });
});
