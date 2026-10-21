import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { teamDailyPath } from "../memory/teamDaily.ts";
import type { TeamDailyWorkspace } from "../memory/teamDailySource.ts";
import {
  deviceId,
  identityOf,
  projectId,
  teamA,
  teamProjectFixture as fixture,
} from "./testing/teamProjectFixture.ts";

const author = identityOf("alice");
const day = "2026-10-10";
const path = teamDailyPath(author, day, deviceId);

/**
 * Alice linked a project to team A, uses Teams here, and Microsoft is connected. With short tokens,
 * every Graph request refreshes the Microsoft token first.
 */
const linkedWith = (options: { shortTokens?: boolean } = {}) =>
  Effect.gen(function* () {
    const f = fixture();
    if (options.shortTokens) f.shortTokens();
    const services = yield* f.make;
    yield* services.connect(teamA);
    yield* services.service.teams("s", { action: "list" });
    yield* services.service.execute("s", { action: "bind", teamId: teamA, projectId });
    const source = f.daily.source!;
    const account = yield* source.account([]);
    if (account.kind !== "signed-in") return yield* Effect.die("expected a signed-in account");
    const workspace = account.workspaces.find((entry) => entry.teamId === teamA)!;
    let shared = true;
    // A removal names the version last written; the fixture reports every file as "v1".
    const write = (text: string | null, current: TeamDailyWorkspace = workspace) =>
      source.write({
        teamId: teamA,
        author,
        path,
        text,
        etag: text === null ? "v1" : null,
        storageKey: null,
        freshProjects: current.projects,
        stillShared: Effect.sync(() => shared),
      });
    const changes = () =>
      f.writes.filter((entry) => entry.method !== "GET" && entry.url.includes("/Daily/"));
    return {
      f,
      ...services,
      source,
      account,
      workspace,
      write,
      changes,
      optOut: () => {
        shared = false;
      },
    };
  });
const linked = linkedWith();

/** The token refresh right before the file's own request: after its folder was looked up. */
const beforeTheWrite = (f: ReturnType<typeof fixture>) => () =>
  f.graph.at(-1)?.endsWith(`/Daily/${author}/${day.slice(0, 7)}`) ?? false;

describe("Daily team memory writes", () => {
  it.effect("writes the author's own file in a linked team and reports access", () =>
    Effect.gen(function* () {
      const team = yield* linked;
      expect(team.account).toMatchObject({ kind: "signed-in", author });
      expect(team.workspace).toMatchObject({
        access: "ready",
        projects: [{ projectId, sharingSince: expect.any(String) }],
      });
      expect(yield* team.write("# shared")).toMatchObject({ kind: "written", etag: "v1" });
      expect(team.changes()).toEqual([
        expect.objectContaining({ method: "PUT", body: "" }),
        expect.objectContaining({ method: "PUT", body: "# shared" }),
      ]);
    }),
  );

  const changesDuringRefresh = [
    {
      name: "a thread is chosen as Don't share",
      change: (team: Effect.Success<typeof linked>) => Effect.sync(() => team.optOut()),
    },
    {
      name: "the project is unlinked",
      change: (team: Effect.Success<typeof linked>) =>
        team.service.execute("s", { action: "unbind", teamId: teamA, projectId }),
    },
    {
      name: "another campus account signs in",
      change: (team: Effect.Success<typeof linked>) =>
        Effect.sync(() => team.f.switchTo("mallory")),
    },
    {
      name: "the member is removed from the team",
      change: (team: Effect.Success<typeof linked>) =>
        Effect.sync(() => void delete team.f.roles[teamA]!.alice),
    },
    {
      name: "the member becomes read-only",
      change: (team: Effect.Success<typeof linked>) =>
        Effect.sync(() => {
          team.f.roles[teamA]!.alice = "reader";
        }),
    },
    {
      name: "the team folder changes",
      change: (team: Effect.Success<typeof linked>) =>
        Effect.sync(() => {
          team.f.storage[teamA] = { ...team.f.storage[teamA]!, folderId: "rootA2" };
        }),
    },
  ];
  it.effect.each(changesDuringRefresh)(
    "sends nothing when $name while the token refreshes",
    (scenario) =>
      Effect.gen(function* () {
        const team = yield* linkedWith({ shortTokens: true });
        team.f.duringTokenRefresh(beforeTheWrite(team.f), scenario.change(team));
        const result = yield* team.write("# withdrawn");
        expect(result).toMatchObject({ kind: "held" });
        expect(team.changes()).toEqual([]);
      }),
  );
  it.effect.each(changesDuringRefresh)(
    "removes nothing when $name while the token refreshes",
    (scenario) =>
      Effect.gen(function* () {
        const team = yield* linkedWith({ shortTokens: true });
        team.f.duringTokenRefresh(beforeTheWrite(team.f), scenario.change(team));
        const result = yield* team.write(null);
        expect(result).toMatchObject({ kind: "held" });
        expect(team.changes()).toEqual([]);
      }),
  );

  it.effect("refuses a path in another author's folder", () =>
    Effect.gen(function* () {
      const team = yield* linked;
      const result = yield* team.source.write({
        teamId: teamA,
        author: identityOf("bob"),
        path: teamDailyPath(identityOf("bob"), day, deviceId),
        text: "# not mine",
        etag: null,
        storageKey: null,
        freshProjects: [],
        stillShared: Effect.succeed(true),
      });
      expect(result).toMatchObject({ kind: "held" });
      expect(team.changes()).toEqual([]);
    }),
  );

  it.effect("holds while the team can't be checked, and stops when membership ends", () =>
    Effect.gen(function* () {
      const team = yield* linked;
      team.f.setTeamsDown(true);
      expect(yield* team.source.account([teamA])).toMatchObject({ kind: "unavailable" });
      expect(yield* team.write("# later")).toMatchObject({ kind: "held" });
      team.f.setTeamsDown(false);
      delete team.f.roles[teamA]!.alice;
      const account = yield* team.source.account([teamA]);
      expect(account.kind === "signed-in" && account.workspaces).toEqual([
        expect.objectContaining({ teamId: teamA, access: "lost" }),
      ]);
      expect(yield* team.write("# gone")).toEqual({ kind: "lost" });
      expect(team.changes()).toEqual([]);
    }),
  );

  it.effect("shares nothing from a project whose link no longer matches the team folder", () =>
    Effect.gen(function* () {
      const team = yield* linked;
      team.f.storage[teamA] = { ...team.f.storage[teamA]!, folderId: "rootA2" };
      const account = yield* team.source.account([]);
      expect(account.kind === "signed-in" && account.workspaces).toEqual([
        expect.objectContaining({ teamId: teamA, access: "ready", projects: [] }),
      ]);
      expect(yield* team.write("# moved", team.workspace)).toMatchObject({ kind: "held" });
      expect(team.changes()).toEqual([]);
    }),
  );

  it.effect("shares nothing while the Teams account's session belongs to someone else", () =>
    Effect.gen(function* () {
      const team = yield* linked;
      team.f.roles[teamA]!.bob = "member";
      team.f.switchTo("bob");
      // Nobody made Bob the Teams account here, so nothing is shared as him or as Alice.
      expect(yield* team.source.account([teamA])).toEqual({ kind: "signed-out" });
      expect(yield* team.write("# as Alice")).toMatchObject({ kind: "held" });
      const asBob = yield* team.source.write({
        teamId: teamA,
        author: identityOf("bob"),
        path: teamDailyPath(identityOf("bob"), day, deviceId),
        text: "# as Bob",
        etag: null,
        storageKey: null,
        freshProjects: [],
        stillShared: Effect.succeed(true),
      });
      expect(asBob).toMatchObject({ kind: "held" });
      expect(team.changes()).toEqual([]);
    }),
  );

  it.effect(
    "starts a reassigned account's sharing when it took over, not when the project was linked",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-01T09:00:00.000Z"));
        const team = yield* linked;
        expect(team.workspace.projects).toEqual([
          { projectId, sharingSince: "2026-10-01T09:00:00.000Z" },
        ]);
        yield* TestClock.setTime(Date.parse("2026-10-05T09:00:00.000Z"));
        team.f.roles[teamA]!.bob = "member";
        team.f.switchTo("bob");
        // Bob uses Teams here, which makes him the Teams account from now on.
        yield* team.service.teams("s", { action: "list" });
        const account = yield* team.source.account([]);
        expect(account).toMatchObject({ kind: "signed-in", author: identityOf("bob") });
        expect(account.kind === "signed-in" && account.workspaces[0]?.projects).toEqual([
          { projectId, sharingSince: "2026-10-05T09:00:00.000Z" },
        ]);
      }),
  );

  it.effect("refuses to write a file anywhere but the folder it was published to", () =>
    Effect.gen(function* () {
      const team = yield* linked;
      expect(team.workspace.storageKey).toEqual(expect.stringContaining("rootA"));
      const result = yield* team.source.write({
        teamId: teamA,
        author,
        path,
        text: null,
        etag: "v1",
        storageKey: "an earlier folder",
        freshProjects: [],
        stillShared: Effect.succeed(true),
      });
      expect(result).toMatchObject({ kind: "rejected" });
      expect(team.changes()).toEqual([]);
    }),
  );

  it.effect.each(["first upload", "withdrawal"] as const)(
    "never takes a %s as done while Microsoft isn't connected, and finishes after reconnecting",
    (kind) =>
      Effect.gen(function* () {
        const team = yield* linked;
        yield* team.storage.execute("s", { action: "disconnect", teamId: teamA });
        const text = kind === "first upload" ? "# shared" : null;
        expect(yield* team.write(text)).toMatchObject({ kind: "held" });
        expect(team.changes()).toEqual([]);
        yield* team.connect(teamA);
        expect(yield* team.write(text)).toMatchObject({ kind: "written" });
        expect(team.changes()).toEqual(
          kind === "first upload"
            ? [
                expect.objectContaining({ method: "PUT", body: "" }),
                expect.objectContaining({ method: "PUT", body: "# shared" }),
              ]
            : [expect.objectContaining({ method: "DELETE" })],
        );
      }),
  );
});
