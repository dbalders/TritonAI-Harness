import { describe, expect, it } from "@effect/vitest";
import type { TeamsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  deviceId,
  identityOf,
  projectId,
  recordId,
  teamA,
  teamProjectFixture as fixture,
} from "./testing/teamProjectFixture.ts";

const code = <A>(effect: Effect.Effect<A, TeamsError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code));
const author = identityOf("alice");
const documentIn = (root: string) => `${root}/${author}/${deviceId}/${recordId}.md`;

/** A linked team A with one published document in each top-level folder, and Microsoft connected. */
const linkedTeam = Effect.gen(function* () {
  const f = fixture();
  for (const root of ["Memory", "SOPs", "Skills"]) {
    f.children.set(`rootA:${root}`, [author]);
    f.children.set(`rootA:${root}/${author}`, [deviceId]);
    f.children.set(`rootA:${root}/${author}/${deviceId}`, [`${recordId}.md`]);
  }
  const services = yield* f.make;
  yield* services.connect(teamA);
  yield* services.service.execute("s", { action: "bind", teamId: teamA, projectId });
  const mirrored = yield* services.service.execute("s", { action: "mirror-on", teamId: teamA });
  const source = f.mirror.source!;
  const mirrors = services.service
    .execute("s", { action: "mirror-list" })
    .pipe(Effect.map((result) => result.mirrors ?? []));
  return { f, ...services, mirrored, source, mirrors };
});

describe("Local team copies", () => {
  it.effect("copies only a linked team's memory notes and SOPs, and stops on request", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      // The project link names the folder to copy.
      expect(yield* code(service.execute("s", { action: "mirror-on", teamId: teamA }))).toBe(
        "invalid_request",
      );

      const { mirrored, source, mirrors, f: linked, service: other } = yield* linkedTeam;
      expect(mirrored.mirrors).toEqual([
        {
          teamId: teamA,
          teamName: "Team A",
          folder: expect.stringMatching(/^teams\/team-a-[a-f0-9]{6}$/u),
          state: "mirrored",
          lastSyncedAt: null,
          message: null,
        },
      ]);
      const folder = mirrored.mirrors![0]!.folder.slice("teams/".length);
      expect(yield* source.teams).toEqual([{ teamId: teamA, folder }]);
      const listing = yield* source.list(teamA);
      expect(listing.kind === "files" && listing.files.map((file) => file.path)).toEqual([
        documentIn("Memory"),
        documentIn("SOPs"),
      ]);
      expect(yield* source.read(teamA, documentIn("Memory"))).toMatchObject({ kind: "file" });
      // Skills reach agents only through the per-project approval in Settings → Skills.
      expect(yield* source.read(teamA, documentIn("Skills"))).toEqual({ kind: "skip" });

      yield* source.report(teamA, {
        kind: "synced",
        at: "2026-10-09T12:00:00.000Z",
        files: 2,
        skipped: 0,
        pending: 0,
      });
      expect((yield* mirrors)[0]).toMatchObject({ lastSyncedAt: "2026-10-09T12:00:00.000Z" });

      const prunes = linked.mirror.prunes;
      const stopped = yield* other.execute("s", { action: "mirror-off", teamId: teamA });
      expect(stopped.mirrors).toEqual([]);
      expect(linked.mirror.prunes).toBe(prunes + 1);
      expect(yield* source.teams).toEqual([]);
      expect(yield* source.list(teamA)).toEqual({ kind: "detached" });
    }),
  );

  const endings = [
    {
      name: "the project is unlinked",
      end: ({ service }: Effect.Success<typeof linkedTeam>) =>
        service.execute("s", { action: "unbind", teamId: teamA, projectId }).pipe(Effect.asVoid),
      message: /No project in this environment is linked/u,
    },
    {
      name: "the member is removed from the team",
      end: ({ f }: Effect.Success<typeof linkedTeam>) =>
        Effect.sync(() => void delete f.roles[teamA]!.alice),
      message: /no longer have access to this team/u,
    },
    {
      name: "the team is archived",
      end: ({ f }: Effect.Success<typeof linkedTeam>) => Effect.sync(() => f.archive(teamA)),
      message: /archived/u,
    },
    {
      name: "Graph refuses the team folder",
      end: ({ f }: Effect.Success<typeof linkedTeam>) => Effect.sync(() => f.denied.add("rootA")),
      message: /folder is no longer available/u,
    },
    {
      name: "the team folder changes",
      end: ({ f }: Effect.Success<typeof linkedTeam>) =>
        Effect.sync(() => {
          f.storage[teamA] = { ...f.storage[teamA]!, folderId: "rootA2" };
        }),
      message: /folder changed/u,
    },
    {
      name: "another campus account signs in",
      end: ({ f }: Effect.Success<typeof linkedTeam>) => Effect.sync(() => f.switchTo("mallory")),
      message: /different UC San Diego account/u,
    },
  ];
  for (const ending of endings)
    it.effect(`removes the copy on the next pass after ${ending.name}`, () =>
      Effect.gen(function* () {
        const team = yield* linkedTeam;
        yield* ending.end(team);
        // A pass lists the teams to keep, then each team; either way the copy is detached.
        const kept = yield* team.source.teams;
        if (kept.length > 0) expect(yield* team.source.list(teamA)).toEqual({ kind: "detached" });
        expect(yield* team.source.teams).toEqual([]);
        if (ending.name === "another campus account signs in") {
          // The other account doesn't see this one's copies; the original account does.
          expect(yield* team.mirrors).toEqual([]);
          team.f.switchTo("alice");
        }
        expect(yield* team.mirrors).toEqual([
          expect.objectContaining({
            state: "detached",
            message: expect.stringMatching(ending.message),
          }),
        ]);
        // Dismissing the notice is the way back to a clean slate.
        yield* team.service.execute("s", { action: "mirror-off", teamId: teamA });
        expect(yield* team.mirrors).toEqual([]);
      }),
    );

  it.effect("removes copies read through a session when it signs out", () =>
    Effect.gen(function* () {
      const team = yield* linkedTeam;
      const prunes = team.f.mirror.prunes;
      yield* team.service.signOutAccount("s");
      expect(team.f.mirror.prunes).toBe(prunes + 1);
      expect(yield* team.source.teams).toEqual([]);
      expect(yield* team.mirrors).toEqual([
        expect.objectContaining({
          state: "detached",
          message: expect.stringMatching(/signed out/u),
        }),
      ]);
      // Turning it on again resumes the same folder.
      const again = yield* team.service.execute("s", { action: "mirror-on", teamId: teamA });
      expect(again.mirrors).toEqual([
        expect.objectContaining({ state: "mirrored", folder: team.mirrored.mirrors![0]!.folder }),
      ]);
    }),
  );

  it.effect("removes the copy with a stuck link removed for a team you can't open", () =>
    Effect.gen(function* () {
      const team = yield* linkedTeam;
      delete team.f.roles[teamA]!.alice;
      const prunes = team.f.mirror.prunes;
      yield* team.service.execute("s", { action: "remove-link", projectId });
      expect(team.f.mirror.prunes).toBe(prunes + 1);
      expect(yield* team.source.teams).toEqual([]);
    }),
  );

  it.effect("keeps the copy as it is when access can't be checked", () =>
    Effect.gen(function* () {
      const team = yield* linkedTeam;
      team.f.setTeamsDown(true);
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
