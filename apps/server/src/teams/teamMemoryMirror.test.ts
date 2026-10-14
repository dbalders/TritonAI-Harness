// @effect-diagnostics globalDate:off globalDateInEffect:off - fixtures use host-local times.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  deviceId,
  identityOf,
  recordId,
  teamA,
  teamProjectFixture as fixture,
} from "./testing/teamProjectFixture.ts";

const author = identityOf("alice");
const bob = identityOf("bob");
const documentIn = (root: string) => `${root}/${author}/${deviceId}/${recordId}.md`;
const dailyIn = (month: string, day: string, who = bob) =>
  `Daily/${who}/${month}/${day} ${deviceId}.md`;
const markerOf = (who = bob) => `Daily/${who}/${deviceId}.changes.json`;
const NOW = new Date(2026, 9, 10, 12).getTime();

/** Team A with one document in each top-level folder, Bob's daily memory, and Microsoft connected. */
const memberOfTeam = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const f = fixture();
  for (const root of ["Memory", "SOPs", "Skills"]) {
    f.children.set(`rootA:${root}`, [author]);
    f.children.set(`rootA:${root}/${author}`, [deviceId]);
    f.children.set(`rootA:${root}/${author}/${deviceId}`, [`${recordId}.md`]);
  }
  f.children.set("rootA:Daily", [bob]);
  f.children.set(`rootA:Daily/${bob}`, ["2026-10", "2025-01", `${deviceId}.changes.json`]);
  f.children.set(`rootA:Daily/${bob}/2026-10`, [`2026-10-09 ${deviceId}.md`]);
  f.children.set(`rootA:Daily/${bob}/2025-01`, [`2025-01-05 ${deviceId}.md`]);
  const marker = (months: Record<string, string>) =>
    f.contents.set(`rootA:${markerOf()}`, JSON.stringify({ version: 1, months }));
  marker({ "2026-10": "2026-10-09T20:00:00.000Z", "2025-01": "2025-01-05T20:00:00.000Z" });
  const services = yield* f.make;
  yield* services.connect(teamA);
  // Using Teams makes this session the environment's Teams account.
  yield* services.service.teams("s", { action: "list" });
  const source = f.mirror.source!;
  // The copy exists from the first pass.
  yield* source.teams;
  const mirrors = services.service
    .execute("s", { action: "mirror-list" })
    .pipe(Effect.map((result) => result.mirrors ?? []));
  const synced = source.report(teamA, {
    kind: "synced",
    at: "2026-10-10T12:00:00.000Z",
    files: 0,
    skipped: 0,
    pending: 0,
  });
  return { f, ...services, source, mirrors, marker, synced };
});

const paths = (listing: { kind: string; files?: ReadonlyArray<{ path: string }> }) =>
  listing.kind === "files" ? listing.files!.map((file) => file.path) : listing.kind;

describe("Local team copies", () => {
  it.effect("copies every team the account belongs to, without a project link, until stopped", () =>
    Effect.gen(function* () {
      const { source, mirrors, service, f } = yield* memberOfTeam;
      const [copy] = yield* source.teams;
      expect(copy).toEqual({
        teamId: teamA,
        folder: expect.stringMatching(/^team-a-[a-f0-9]{6}$/u),
      });
      expect(yield* mirrors).toEqual([
        expect.objectContaining({ teamId: teamA, teamName: "Team A", state: "mirrored" }),
      ]);
      const listing = yield* source.list(teamA);
      // Skills reach agents only through the per-project approval in Settings → Skills.
      expect(paths(listing)).toEqual([
        documentIn("Memory"),
        documentIn("SOPs"),
        dailyIn("2026-10", "2026-10-09"),
        dailyIn("2025-01", "2025-01-05"),
      ]);
      expect(yield* source.read(teamA, documentIn("Skills"))).toEqual({ kind: "skip" });
      expect(yield* source.read(teamA, markerOf())).toEqual({ kind: "skip" });
      expect(yield* source.read(teamA, dailyIn("2026-10", "2026-10-09"))).toMatchObject({
        kind: "file",
      });

      const prunes = f.mirror.prunes;
      const stopped = yield* service.execute("s", { action: "mirror-off", teamId: teamA });
      expect(stopped.mirrors).toEqual([expect.objectContaining({ state: "off" })]);
      expect(f.mirror.prunes).toBe(prunes + 1);
      expect(yield* source.teams).toEqual([]);
      expect(yield* source.list(teamA)).toEqual({ kind: "detached" });
      const kept = yield* service.execute("s", { action: "mirror-on", teamId: teamA });
      expect(kept.mirrors).toEqual([expect.objectContaining({ state: "mirrored" })]);
      expect(yield* source.teams).toEqual([copy]);
    }),
  );

  it.effect("lists older months only when a member's marker says they changed, or once a day", () =>
    Effect.gen(function* () {
      const { source, marker, synced } = yield* memberOfTeam;
      // The first listing after start is complete.
      yield* source.teams;
      expect(paths(yield* source.list(teamA))).toContain(dailyIn("2025-01", "2025-01-05"));
      yield* synced;

      // An ordinary pass lists recent months and leaves the old one exactly as it is.
      const ordinary = yield* source.list(teamA);
      expect(paths(ordinary)).not.toContain(dailyIn("2025-01", "2025-01-05"));
      expect(ordinary).toMatchObject({ unlisted: [`Daily/${bob}/2025-01`] });
      yield* synced;

      // Bob withdraws a thread from an old day: his device rewrites the month and stamps it.
      marker({ "2026-10": "2026-10-09T20:00:00.000Z", "2025-01": "2026-10-10T11:00:00.000Z" });
      const changed = yield* source.list(teamA);
      expect(paths(changed)).toContain(dailyIn("2025-01", "2025-01-05"));
      expect(changed).toMatchObject({ unlisted: [] });
      // Until the copy reports it matched, the month is listed again.
      expect(paths(yield* source.list(teamA))).toContain(dailyIn("2025-01", "2025-01-05"));
      yield* synced;
      expect(paths(yield* source.list(teamA))).not.toContain(dailyIn("2025-01", "2025-01-05"));
      yield* synced;

      // Changes made directly in SharePoint are caught by the daily complete listing.
      yield* TestClock.adjust(24 * 60 * 60_000);
      expect(paths(yield* source.list(teamA))).toContain(dailyIn("2025-01", "2025-01-05"));
    }),
  );

  it.effect("lists every month of a member whose marker can't be read", () =>
    Effect.gen(function* () {
      const { source, f, synced } = yield* memberOfTeam;
      yield* source.list(teamA);
      yield* synced;
      f.contents.set(`rootA:${markerOf()}`, "not json");
      expect(paths(yield* source.list(teamA))).toContain(dailyIn("2025-01", "2025-01-05"));
    }),
  );

  const endings = [
    {
      name: "the member is removed from the team",
      end: ({ f }: Effect.Success<typeof memberOfTeam>) =>
        Effect.sync(() => void delete f.roles[teamA]!.alice),
      message: /no longer have access to this team/u,
    },
    {
      name: "the team is archived",
      end: ({ f }: Effect.Success<typeof memberOfTeam>) => Effect.sync(() => f.archive(teamA)),
      message: /archived/u,
    },
    {
      name: "Graph refuses the team folder",
      end: ({ f }: Effect.Success<typeof memberOfTeam>) => Effect.sync(() => f.denied.add("rootA")),
      message: /folder is no longer available/u,
    },
    {
      name: "another campus account signs in",
      end: ({ f }: Effect.Success<typeof memberOfTeam>) => Effect.sync(() => f.switchTo("mallory")),
      message: /different UC San Diego account/u,
    },
  ];
  for (const ending of endings)
    it.effect(`removes the copy on the next pass after ${ending.name}`, () =>
      Effect.gen(function* () {
        const team = yield* memberOfTeam;
        yield* ending.end(team);
        // A pass lists the teams to keep, then each team; either way the copy is detached.
        const kept = yield* team.source.teams;
        if (kept.length > 0) expect(yield* team.source.list(teamA)).toEqual({ kind: "detached" });
        expect(yield* team.source.teams).toEqual([]);
        if (ending.name === "another campus account signs in") {
          // The other account doesn't see this one's copies; the original account's comes back.
          expect(yield* team.mirrors).toEqual([]);
          team.f.switchTo("alice");
          expect(yield* team.mirrors).toEqual([expect.objectContaining({ state: "mirrored" })]);
          return;
        }
        expect(yield* team.mirrors).toEqual([
          expect.objectContaining({
            state: "detached",
            message: expect.stringMatching(ending.message),
          }),
        ]);
      }),
    );

  it.effect("removes copies read through a session when it signs out", () =>
    Effect.gen(function* () {
      const team = yield* memberOfTeam;
      const prunes = team.f.mirror.prunes;
      yield* team.service.signOutAccount("s");
      expect(team.f.mirror.prunes).toBe(prunes + 1);
      expect(yield* team.source.teams).toEqual([]);
    }),
  );

  it.effect("keeps a stopped copy stopped when the same account signs out and back in", () =>
    Effect.gen(function* () {
      const team = yield* memberOfTeam;
      yield* team.service.execute("s", { action: "mirror-off", teamId: teamA });
      team.f.signOut();
      expect(yield* team.source.teams).toEqual([]);
      team.f.signIn();
      expect(yield* team.source.teams).toEqual([]);
      expect(yield* team.source.list(teamA)).toEqual({ kind: "detached" });
      expect(yield* team.mirrors).toEqual([expect.objectContaining({ state: "off" })]);

      // Nor when another campus account uses the session in between.
      team.f.switchTo("mallory");
      yield* team.source.teams;
      team.f.switchTo("alice");
      expect(yield* team.mirrors).toEqual([expect.objectContaining({ state: "off" })]);
    }),
  );

  it.effect("keeps each account's own choice when another account copies the same team", () =>
    Effect.gen(function* () {
      const team = yield* memberOfTeam;
      yield* team.service.execute("s", { action: "mirror-off", teamId: teamA });

      // Bob becomes the Teams account here: his copy starts, untouched by Alice's choice.
      team.f.switchTo("bob");
      team.f.roles[teamA]!.bob = "member";
      yield* team.service.teams("s", { action: "list" });
      expect(yield* team.source.teams).toEqual([expect.objectContaining({ teamId: teamA })]);
      yield* team.service.execute("s", { action: "mirror-off", teamId: teamA });
      yield* team.service.execute("s", { action: "mirror-on", teamId: teamA });

      // Alice is back: her copy stays stopped, and Bob's choice stays his.
      team.f.switchTo("alice");
      yield* team.service.teams("s", { action: "list" });
      expect(yield* team.source.teams).toEqual([]);
      expect(yield* team.mirrors).toEqual([expect.objectContaining({ state: "off" })]);
      team.f.switchTo("bob");
      yield* team.service.teams("s", { action: "list" });
      expect(yield* team.source.teams).toEqual([expect.objectContaining({ teamId: teamA })]);
    }),
  );

  it.effect("keeps a stop when the notice of a detached copy is dismissed", () =>
    Effect.gen(function* () {
      const team = yield* memberOfTeam;
      yield* team.service.execute("s", { action: "mirror-off", teamId: teamA });

      // Bob's copy of the team carries Alice's stop; his membership ends and he dismisses it.
      team.f.switchTo("bob");
      team.f.roles[teamA]!.bob = "member";
      yield* team.service.teams("s", { action: "list" });
      yield* team.source.teams;
      delete team.f.roles[teamA]!.bob;
      expect(yield* team.source.teams).toEqual([]);
      expect(yield* team.mirrors).toEqual([expect.objectContaining({ state: "detached" })]);
      const dismissed = yield* team.service.execute("s", { action: "mirror-off", teamId: teamA });
      expect(dismissed.mirrors).toEqual([]);

      // Alice's copy is still stopped when she's back.
      team.f.switchTo("alice");
      yield* team.service.teams("s", { action: "list" });
      expect(yield* team.source.teams).toEqual([]);
      expect(yield* team.mirrors).toEqual([expect.objectContaining({ state: "off" })]);
    }),
  );

  it.effect("keeps the copy as it is when access can't be checked", () =>
    Effect.gen(function* () {
      const team = yield* memberOfTeam;
      team.f.setTeamsDown(true);
      expect(yield* team.source.teams).toEqual([expect.objectContaining({ teamId: teamA })]);
      expect(yield* team.source.list(teamA)).toEqual({ kind: "unavailable" });
      team.f.setTeamsDown(false);
      // Microsoft disconnected for Teams on this device.
      yield* team.storage.execute("s", { action: "disconnect", teamId: teamA });
      expect(yield* team.source.list(teamA)).toEqual({ kind: "unavailable" });
      expect(yield* team.source.teams).toEqual([expect.objectContaining({ teamId: teamA })]);
      expect(yield* team.mirrors).toEqual([
        expect.objectContaining({
          state: "mirrored",
          message: expect.stringMatching(/Connect Microsoft/u),
        }),
      ]);
    }),
  );
});
