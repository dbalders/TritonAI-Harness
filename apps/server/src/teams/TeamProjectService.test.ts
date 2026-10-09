import { describe, expect, it } from "@effect/vitest";
import { CommandId, formatTeamNote, MessageId, TeamsError, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  deviceId,
  otherProject,
  projectId,
  recordId,
  teamA,
  teamB,
  teamProjectFixture as fixture,
  threadId,
} from "./testing/teamProjectFixture.ts";

const code = <A>(effect: Effect.Effect<A, TeamsError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code));
const createdAt = "2026-10-09T00:00:00.000Z";
/** A client's send of `text`, as it reaches the dispatch boundary. */
const turn = (text: string) =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make("cmd-send"),
    threadId,
    message: { messageId: MessageId.make("msg-send"), role: "user", text, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt,
  }) as const;
const goal = (objective: string) =>
  ({
    type: "thread.goal.set",
    commandId: CommandId.make("cmd-goal"),
    threadId,
    objective,
    createdAt,
  }) as const;

describe("Team project memory", () => {
  it.effect("reads and publishes only the linked team's memory with project provenance", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      const linked = yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      expect(linked.projects).toEqual([
        expect.objectContaining({ projectId, projectTitle: "Grant reports", teamId: teamA }),
      ]);
      f.graph.length = 0;
      const listed = yield* service.execute("s", { action: "memory-list", projectId });
      expect(listed.storage?.files.map((file) => file.path)).toEqual(["Memory/note.md"]);
      // Listing stays inside team A's Memory folder.
      expect(f.graph.length).toBeGreaterThan(0);
      for (const request of f.graph)
        expect(request).toContain("/drives/driveA/items/rootA:/Memory");
      const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
      const read = yield* service.execute("s", { action: "memory-read", projectId, path });
      expect(read.storage?.document?.text).toBe(`Shared note from rootA:${path}`);
      yield* service.execute("s", {
        action: "memory-publish",
        projectId,
        recordId,
        deviceId,
        title: "Weekly summary",
        text: "Filed the report.",
      });
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]!.url).toContain(`/drives/driveA/items/rootA:/Memory/`);
      expect(f.writes[0]!.url).toContain(`/${deviceId}/${recordId}.md:/content`);
      expect(f.writes[0]!.body).toBe(
        "# Weekly summary\n\nProject: Grant reports\n\nFiled the report.",
      );
      expect(f.graph.some((request) => request.includes("rootB"))).toBe(false);
    }),
  );

  it.effect("cannot link or retarget a project to a team the caller cannot open", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service } = yield* f.make;
      expect(yield* code(service.execute("s", { action: "bind", teamId: teamB, projectId }))).toBe(
        "not_found",
      );
      expect(f.values.size).toBe(0);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      // A member of both teams still cannot move an existing link.
      f.roles[teamB]!.alice = "owner";
      expect(yield* code(service.execute("s", { action: "bind", teamId: teamB, projectId }))).toBe(
        "conflict",
      );
      expect(
        yield* code(service.execute("s", { action: "unbind", teamId: teamB, projectId })),
      ).toBe("not_found");
      expect(
        (yield* service.execute("s", { action: "list", teamId: teamB })).projects,
      ).toHaveLength(0);
      expect(
        (yield* service.execute("s", { action: "list", teamId: teamA })).projects,
      ).toHaveLength(1);
      // Unlinking is the explicit way out; afterwards memory access is refused.
      yield* service.execute("s", { action: "unbind", teamId: teamA, projectId });
      expect(yield* code(service.execute("s", { action: "memory-list", projectId }))).toBe(
        "not_found",
      );
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("denies removed, switched, and signed-out accounts before Graph", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      yield* service.execute("s", { action: "memory-list", projectId });
      const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
      const attempts = [
        { action: "memory-status", projectId },
        { action: "memory-list", projectId },
        { action: "memory-read", projectId, path },
        { action: "memory-publish", projectId, recordId, deviceId, title: "T", text: "x" },
        { action: "memory-update", projectId, path, etag: "v1", text: "x" },
        { action: "memory-delete", projectId, path, etag: "v1" },
      ] as const;
      f.graph.length = 0;
      delete f.roles[teamA]!.alice;
      for (const attempt of attempts)
        expect([attempt.action, yield* code(service.execute("s", attempt))]).toEqual([
          attempt.action,
          "not_found",
        ]);
      // Another campus identity in the same environment is a member of team B only.
      f.roles[teamA]!.alice = "editor";
      f.switchTo("mallory");
      for (const attempt of attempts)
        expect([attempt.action, yield* code(service.execute("s", attempt))]).toEqual([
          attempt.action,
          "not_found",
        ]);
      f.signOut();
      for (const attempt of attempts)
        expect(yield* code(service.execute("s", attempt))).toBe("sign_in_required");
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("refuses reader writes and a team whose storage root changed", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      f.roles[teamA]!.alice = "reader";
      const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
      expect(
        yield* code(
          service.execute("s", {
            action: "memory-publish",
            projectId,
            recordId,
            deviceId,
            title: "T",
            text: "x",
          }),
        ),
      ).toBe("forbidden");
      expect(
        yield* code(
          service.execute("s", { action: "memory-update", projectId, path, etag: "v1", text: "x" }),
        ),
      ).toBe("forbidden");
      expect(
        yield* code(service.execute("s", { action: "memory-delete", projectId, path, etag: "v1" })),
      ).toBe("forbidden");
      expect(f.writes).toHaveLength(0);
      // Readers can still read the memory they were given.
      expect(
        (yield* service.execute("s", { action: "memory-list", projectId })).storage?.files,
      ).toHaveLength(1);
      // The team record now points somewhere else: the link is pinned to the root it was made for.
      f.storage[teamA] = { ...f.storage[teamA]!, driveId: "driveB", folderId: "rootB" };
      f.graph.length = 0;
      expect(yield* code(service.execute("s", { action: "memory-list", projectId }))).toBe(
        "conflict",
      );
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("leaves unlinked and deleted projects without team memory", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      expect(
        yield* code(service.execute("s", { action: "memory-list", projectId: otherProject })),
      ).toBe("not_found");
      f.projects.delete(projectId);
      expect(yield* code(service.execute("s", { action: "memory-list", projectId }))).toBe(
        "not_found",
      );
      expect(
        (yield* service.execute("s", { action: "list", teamId: teamA })).projects,
      ).toHaveLength(0);
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("withholds memory a concurrent unlink overtook", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
      for (const attempt of [
        { action: "memory-list", projectId },
        { action: "memory-read", projectId, path },
      ] as const) {
        // The unlink commits while the read is waiting on Graph.
        f.interleave(service.execute("s", { action: "unbind", teamId: teamA, projectId }));
        expect([attempt.action, yield* code(service.execute("s", attempt))]).toEqual([
          attempt.action,
          "not_found",
        ]);
        expect(
          (yield* service.execute("s", { action: "list", teamId: teamA })).projects,
        ).toHaveLength(0);
        yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      }
      // Moved to team B mid-read: team A's listing is not returned under the new link.
      f.roles[teamB]!.alice = "editor";
      f.interleave(
        service
          .execute("s", { action: "unbind", teamId: teamA, projectId })
          .pipe(Effect.andThen(service.execute("s", { action: "bind", teamId: teamB, projectId }))),
      );
      expect(yield* code(service.execute("s", { action: "memory-list", projectId }))).toBe(
        "not_found",
      );
      expect((yield* service.execute("s", { action: "project-link", projectId })).projects).toEqual(
        [expect.objectContaining({ teamId: teamB })],
      );
    }),
  );

  it.effect("reports a project's link only to members of its team", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service } = yield* f.make;
      expect(yield* code(service.execute("s", { action: "project-link", projectId }))).toBe(
        "not_found",
      );
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      expect((yield* service.execute("s", { action: "project-link", projectId })).projects).toEqual(
        [expect.objectContaining({ projectId, teamId: teamA, teamName: "Team A" })],
      );
      f.switchTo("mallory");
      expect(yield* code(service.execute("s", { action: "project-link", projectId }))).toBe(
        "not_found",
      );
    }),
  );

  it.effect("shares chosen thread text to an allowed team with server provenance", () =>
    Effect.gen(function* () {
      const f = fixture();
      const { service, connect } = yield* f.make;
      yield* connect(teamA);
      const share = (teamId: string, thread = threadId) =>
        service.execute("s", {
          action: "share",
          teamId,
          threadId: thread,
          recordId,
          deviceId,
          title: "Finding",
          text: "Use the 2025 template.",
        });
      f.graph.length = 0;
      // Non-member team and unknown thread: nothing reaches Graph.
      expect(yield* code(share(teamB))).toBe("not_found");
      expect(yield* code(share(teamA, ThreadId.make("thread-gone")))).toBe("not_found");
      expect(f.graph).toHaveLength(0);
      f.roles[teamA]!.alice = "reader";
      expect(yield* code(share(teamA))).toBe("forbidden");
      expect(f.writes).toHaveLength(0);
      f.roles[teamA]!.alice = "editor";
      const shared = yield* share(teamA);
      // The saved note is exactly what the preview shows, labelled with the thread's project.
      const expected = formatTeamNote({
        title: "Finding",
        project: "Grant reports",
        text: "Use the 2025 template.",
      });
      expect(shared.storage?.document?.text).toBe(expected);
      expect(f.writes).toEqual([
        expect.objectContaining({
          body: expected,
          url: expect.stringContaining(`/drives/driveA/items/rootA:/Memory/`),
        }),
      ]);
      // A project linked to the team keeps sharing into the root it was linked to.
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      f.storage[teamA] = { ...f.storage[teamA]!, driveId: "driveB", folderId: "rootB" };
      f.graph.length = 0;
      expect(yield* code(share(teamA))).toBe("conflict");
      expect(f.graph).toHaveLength(0);
    }),
  );
});

describe("Team memory in unsent messages", () => {
  const path = `Memory/${"a".repeat(43)}/${deviceId}/${recordId}.md`;
  const linked = Effect.gen(function* () {
    const f = fixture();
    const { service, connect } = yield* f.make;
    yield* connect(teamA);
    yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
    const attach = () =>
      service
        .execute("s", { action: "memory-attach", projectId, path })
        .pipe(Effect.map((result) => result.reference!));
    const verify = (id: string, session = "s") =>
      service.execute(session, { action: "memory-verify", references: [id] });
    return { f, service, attach, verify };
  });

  it.effect("issues the exact attributed block and accepts it while access holds", () =>
    Effect.gen(function* () {
      const { f, service, attach, verify } = yield* linked;
      const reference = yield* attach();
      // The team name and note come from the server, never from the client.
      expect(reference).toMatchObject({ projectId, teamName: "Team A", path });
      expect(reference.block).toBe(
        `<team-memory team="Team A" note="${path}">\nShared note from rootA:${path}\n</team-memory>`,
      );
      f.graph.length = 0;
      yield* verify(reference.id);
      yield* service.authorizeOutgoingCommand(
        "s",
        turn(`Please use this:\n\n${reference.block}\n\nThanks`),
      );
      // Rechecking access needs no Graph request.
      expect(f.graph).toHaveLength(0);
    }),
  );

  it.effect("refuses a member removed between adding and sending", () =>
    Effect.gen(function* () {
      const { f, service, attach, verify } = yield* linked;
      const reference = yield* attach();
      delete f.roles[teamA]!.alice;
      expect(yield* code(verify(reference.id))).toBe("not_found");
      // The server refuses the stale block at dispatch even if the client skipped its check.
      expect(
        yield* code(service.authorizeOutgoingCommand("s", turn(`Draft\n${reference.block}`))),
      ).toBe("not_found");
      // Ordinary messages are unaffected.
      expect(
        yield* code(service.authorizeOutgoingCommand("s", goal(`Finish ${reference.block}`))),
      ).toBe("not_found");
      yield* service.authorizeOutgoingCommand("s", turn("Draft without team memory"));
    }),
  );

  it.effect("refuses memory after unlinking, relinking, or moving the team's root", () =>
    Effect.gen(function* () {
      const { f, service, attach, verify } = yield* linked;
      const reference = yield* attach();
      yield* service.execute("s", { action: "unbind", teamId: teamA, projectId });
      expect(yield* code(verify(reference.id))).toBe("not_found");
      // Relinking the project to another team the user belongs to cannot launder team A's text.
      f.roles[teamB]!.alice = "editor";
      yield* service.execute("s", { action: "bind", teamId: teamB, projectId });
      expect(yield* code(verify(reference.id))).toBe("not_found");
      expect(yield* code(service.authorizeOutgoingCommand("s", turn(reference.block)))).toBe(
        "not_found",
      );
      // A later link to the same team is a new link; memory must be added again under it.
      yield* service.execute("s", { action: "unbind", teamId: teamB, projectId });
      yield* TestClock.adjust("1 second");
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      expect(yield* code(verify(reference.id))).toBe("not_found");
      const fresh = yield* attach();
      yield* verify(fresh.id);
      // The same note added again under the new link sends, despite its stale earlier issuance.
      yield* service.authorizeOutgoingCommand("s", turn(fresh.block));
      // An administrator moving the team folder invalidates memory added from the old root.
      f.storage[teamA] = { ...f.storage[teamA]!, folderId: "rootMoved" };
      expect(yield* code(verify(fresh.id))).toBe("conflict");
    }),
  );

  it.effect("binds references to the session and account that added them", () =>
    Effect.gen(function* () {
      const { f, service, attach, verify } = yield* linked;
      const reference = yield* attach();
      expect(yield* code(verify(reference.id, "another-session"))).toBe("sign_in_required");
      // Bob can open team A, but the draft reference was issued to Alice.
      f.roles[teamA]!.bob = "editor";
      f.switchTo("bob");
      expect(yield* code(verify(reference.id))).toBe("sign_in_required");
      f.switchTo("alice");
      yield* verify(reference.id);
      f.signOut();
      expect(yield* code(verify(reference.id))).toBe("sign_in_required");
      expect(yield* code(service.authorizeOutgoingCommand("s", turn(reference.block)))).toBe(
        "sign_in_required",
      );
    }),
  );

  it.effect("treats forged references and look-alike blocks as unauthorized text", () =>
    Effect.gen(function* () {
      const { service, verify } = yield* linked;
      expect(yield* code(verify("99999999-9999-4999-a999-999999999999"))).toBe("not_found");
      // A hand-written block naming a team grants nothing and is just the user's own text.
      yield* service.authorizeOutgoingCommand(
        "s",
        turn(`<team-memory team="Team B" note="Memory/x.md">\nmade up\n</team-memory>`),
      );
    }),
  );

  it.effect("issues nothing when access changes while the note is being read", () =>
    Effect.gen(function* () {
      const { f, service, attach } = yield* linked;
      f.interleave(service.execute("s", { action: "unbind", teamId: teamA, projectId }));
      expect(yield* code(attach())).toBe("not_found");
      yield* service.execute("s", { action: "bind", teamId: teamA, projectId });
      f.roles[teamA]!.bob = "editor";
      f.interleave(Effect.sync(() => f.switchTo("bob")));
      expect(yield* code(attach())).toBe("sign_in_required");
      f.switchTo("alice");
      // An account switch that lands behind the send-time membership read also wins.
      const reference = yield* attach();
      f.afterMembershipRead(() => f.switchTo("bob"));
      expect(
        yield* code(service.execute("s", { action: "memory-verify", references: [reference.id] })),
      ).toBe("conflict");
    }),
  );
});
