// @effect-diagnostics nodeBuiltinImport:off - Test fixtures use synchronous SHA-256 identity and document fingerprints.
import { expect, it } from "@effect/vitest";
import { CommandId, MessageId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as TeamMessageGate from "./TeamMessageGate.ts";
import {
  deviceId,
  identityOf,
  otherProject,
  projectId,
  recordId,
  teamA,
  teamB,
  teamProjectFixture,
  threadId,
} from "./testing/teamProjectFixture.ts";

const path = `Skills/${identityOf("alice")}/${deviceId}/${recordId}.md`;
const dispatch = (text: string, teamReferences: readonly string[] = []) => ({
  type: "message.dispatch" as const,
  dispatchMode: { type: "queue_after_active" as const },
  commandId: CommandId.make("team-gate-dispatch"),
  messageId: MessageId.make("team-gate-message"),
  threadId,
  text,
  attachments: [],
  createdBy: "user" as const,
  creationSource: "web" as const,
  teamReferences,
});

it.effect.each([
  "removed",
  "switched",
  "signed-out",
  "relinked",
  "root-changed",
  "unreachable",
] as const)("rechecks an edited queued team reference at delivery when access is %s", (change) =>
  Effect.gen(function* () {
    const f = teamProjectFixture();
    const made = yield* f.make;
    yield* made.connect(teamA);
    yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
    const reference = (yield* made.service.execute("s", {
      action: "skill-attach",
      projectId,
      path,
    })).reference!;
    const command = yield* made.service.prepareOutgoingCommand(
      "s",
      dispatch("Edited instructions with the original header removed.", [reference.id]),
    );
    expect(command.type).toBe("message.dispatch");
    const send = made.gate.verifyBeforeSend({
      messageId: "team-gate-message",
      threadId,
      text: command.type === "message.dispatch" ? command.text : "",
    });
    yield* send;
    if (change === "removed") delete f.roles[teamA]!.alice;
    if (change === "switched") {
      f.roles[teamA]!.bob = "member";
      f.switchTo("bob");
    }
    if (change === "signed-out") f.signOut();
    if (change === "root-changed")
      f.storage[teamA] = { ...f.storage[teamA]!, folderId: "new-root" };
    if (change === "unreachable") f.setTeamsDown(true);
    if (change === "relinked") {
      yield* made.service.execute("s", { action: "unbind", teamId: teamA, projectId });
      f.roles[teamB]!.alice = "member";
      yield* made.service.execute("s", { action: "bind", teamId: teamB, projectId });
    }
    expect((yield* Effect.result(send))._tag).toBe("Failure");
    yield* made.gate.verifyBeforeSend({
      messageId: "ordinary-message",
      threadId,
      text: "Ordinary message.",
    });
  }),
);

it.effect("keeps edited message provenance through queue edits and service reconstruction", () =>
  Effect.gen(function* () {
    const f = teamProjectFixture();
    const made = yield* f.make;
    yield* made.connect(teamA);
    yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
    const reference = (yield* made.service.execute("s", {
      action: "skill-attach",
      projectId,
      path,
    })).reference!;
    yield* made.service.prepareOutgoingCommand("s", dispatch("First edited note.", [reference.id]));
    const runId = RunId.make("queued-team-run");
    f.queuedMessages.set(runId, {
      messageId: MessageId.make("team-gate-message"),
      threadId,
      text: "First edited note.",
    });
    const restarted = yield* f.make;
    yield* restarted.service.prepareOutgoingCommand("s", {
      type: "queued-run.edit",
      commandId: CommandId.make("edit-team-message"),
      threadId,
      runId,
      text: "Edited again after reload.",
    });
    yield* restarted.gate.verifyBeforeSend({
      messageId: "team-gate-message",
      threadId,
      text: "Edited again after reload.",
    });
    delete f.roles[teamA]!.alice;
    expect(
      (yield* Effect.result(
        restarted.gate.verifyBeforeSend({
          messageId: "team-gate-message",
          threadId,
          text: "Edited again after reload.",
        }),
      ))._tag,
    ).toBe("Failure");
    // An unprepared edit cannot strip the bound authority by changing the text hash.
    expect(
      (yield* Effect.result(
        restarted.gate.verifyBeforeSend({
          messageId: "team-gate-message",
          threadId,
          text: "Unprepared replacement.",
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect.each(["changed", "disabled"] as const)(
  "holds a queued automatic skill when its approval is %s",
  (change) =>
    Effect.gen(function* () {
      const f = teamProjectFixture();
      const made = yield* f.make;
      yield* made.connect(teamA);
      yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
      const text = "Use the reviewed reporting template.";
      f.contents.set(`rootA:${path}`, text);
      yield* made.service.execute("s", {
        action: "skill-enable",
        projectId,
        path,
        version: NodeCrypto.createHash("sha256").update(text).digest("hex"),
      });
      const prepared = yield* made.service.prepareOutgoingCommand(
        "s",
        dispatch("Draft the report."),
      );
      if (prepared.type !== "message.dispatch") throw new Error("Expected a message");
      yield* made.gate.verifyBeforeSend({
        messageId: prepared.messageId,
        threadId,
        text: prepared.text,
      });
      if (change === "changed") f.contents.set(`rootA:${path}`, "New, unreviewed instructions.");
      else yield* made.service.execute("s", { action: "skill-disable", projectId, path });
      const result = yield* Effect.result(
        made.gate.verifyBeforeSend({
          messageId: prepared.messageId,
          threadId,
          text: prepared.text,
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
);

it.effect("stores server authority in SQL and fails closed until its validator is registered", () =>
  Effect.gen(function* () {
    const gate = yield* TeamMessageGate.TeamMessageGate;
    const reference: TeamMessageGate.Reference = {
      id: "reference",
      sessionId: "session",
      issuer: "https://campus.example.test",
      subject: "alice",
      projectId,
      link: {
        projectId,
        teamId: teamA,
        linkedAt: "2026-10-20T00:00:00Z",
        storage: {
          tenantId: "22222222-2222-4222-a222-222222222222",
          siteId: "site",
          driveId: "drive",
          folderId: "folder",
        },
      },
      block: "<team-skill>Reviewed text</team-skill>",
    };
    yield* gate.remember(reference);
    expect(yield* gate.get(reference.id)).toEqual(reference);
    yield* gate.bind({
      messageId: "sql-message",
      threadId,
      text: "Edited text",
      references: [reference],
    });
    expect(
      (yield* Effect.result(
        gate.verifyBeforeSend({ messageId: "sql-message", threadId, text: "Edited text" }),
      ))._tag,
    ).toBe("Failure");
    let checked = 0;
    yield* gate.registerValidator(() =>
      Effect.sync(() => {
        checked++;
      }),
    );
    yield* gate.verifyBeforeSend({ messageId: "sql-message", threadId, text: "Edited text" });
    expect(checked).toBe(1);
    expect(yield* gate.previous("sql-message")).toEqual([reference]);
  }).pipe(Effect.provide(TeamMessageGate.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it.effect("sends all fifty draft references together with five approved project skills", () =>
  Effect.gen(function* () {
    const f = teamProjectFixture();
    const made = yield* f.make;
    yield* made.connect(teamA);
    yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
    const references = [];
    for (let n = 0; n < 50; n++)
      references.push(
        (yield* made.service.execute("s", { action: "skill-attach", projectId, path })).reference!
          .id,
      );
    for (let n = 1; n <= 5; n++) {
      const skillPath = `Skills/${identityOf("alice")}/${deviceId}/${recordId.slice(0, -1)}${n}.md`;
      const text = `Reviewed instruction ${n}.`;
      f.contents.set(`rootA:${skillPath}`, text);
      yield* made.service.execute("s", {
        action: "skill-enable",
        projectId,
        path: skillPath,
        version: NodeCrypto.createHash("sha256").update(text).digest("hex"),
      });
    }
    const prepared = yield* made.service.prepareOutgoingCommand(
      "s",
      dispatch("Use the edited draft context.", references),
    );
    if (prepared.type !== "message.dispatch") throw new Error("Expected a message");
    expect(prepared.teamReferences).toHaveLength(55);
    yield* made.service.execute("s", {
      action: "memory-verify",
      references: prepared.teamReferences!,
    });
    yield* made.gate.verifyBeforeSend({
      messageId: prepared.messageId,
      threadId,
      text: prepared.text,
    });
  }),
);

it.effect.each(["session", "account", "project"] as const)(
  "keeps identical exact-block references scoped to the sending %s",
  (collision) =>
    Effect.gen(function* () {
      const f = teamProjectFixture();
      const made = yield* f.make;
      yield* made.connect(teamA);
      yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
      const own = (yield* made.service.execute("s", { action: "skill-attach", projectId, path }))
        .reference!;
      let foreignSession = "s";
      let foreignProject = projectId;
      if (collision === "session") {
        foreignSession = "s2";
        const flow = yield* made.storage.execute(foreignSession, {
          action: "connect",
          teamId: teamA,
        });
        yield* made.storage.execute(foreignSession, {
          action: "poll",
          teamId: teamA,
          flowId: flow.flowId!,
        });
      }
      if (collision === "account") {
        f.roles[teamA]!.bob = "member";
        f.switchTo("bob");
        yield* made.connect(teamA);
      }
      if (collision === "project") {
        foreignProject = otherProject;
        yield* made.service.execute("s", {
          action: "bind",
          teamId: teamA,
          projectId: foreignProject,
        });
      }
      const foreign = (yield* made.service.execute(foreignSession, {
        action: "skill-attach",
        projectId: foreignProject,
        path,
      })).reference!;
      expect(foreign.block).toBe(own.block);
      if (collision === "account") f.switchTo("alice");
      const prepared = yield* made.service.prepareOutgoingCommand(
        "s",
        dispatch(own.block, [own.id]),
      );
      expect(prepared.type === "message.dispatch" && prepared.teamReferences).toEqual([own.id]);
      // An older client has no explicit ID; its exact-block fallback is scoped too.
      yield* made.service.authorizeOutgoingCommand("s", dispatch(own.block));
    }),
);

it.effect("expires an evicted legacy block without losing bound queued-message protection", () =>
  Effect.gen(function* () {
    const f = teamProjectFixture();
    const made = yield* f.make;
    yield* made.connect(teamA);
    yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
    const own = (yield* made.service.execute("s", { action: "skill-attach", projectId, path }))
      .reference!;
    const original = (yield* made.gate.get(own.id))!;
    yield* made.service.prepareOutgoingCommand("s", dispatch("Edited queued text.", [own.id]));
    for (let n = 0; n < 256; n++)
      yield* made.gate.remember({
        ...original,
        id: NodeCrypto.randomUUID(),
        block: `${original.block}\nIssuance ${n}.`,
      });
    expect(yield* made.gate.get(own.id)).toBeNull();
    yield* made.gate.verifyBeforeSend({
      messageId: "team-gate-message",
      threadId,
      text: "Edited queued text.",
    });
    delete f.roles[teamA]!.alice;
    const legacy = yield* Effect.result(
      made.service.prepareOutgoingCommand("s", dispatch(own.block)),
    );
    expect(legacy._tag).toBe("Failure");
    expect(
      (yield* Effect.result(
        made.gate.verifyBeforeSend({
          messageId: "team-gate-message",
          threadId,
          text: "Edited queued text.",
        }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("allows ordinary coding messages with tag-name examples while Teams is signed out", () =>
  Effect.gen(function* () {
    const f = teamProjectFixture();
    const made = yield* f.make;
    f.signOut();
    const command = dispatch(
      'Implement a parser for `<team-skill>` and `<team-memory>`. Example: <team-skill team="Demo" skill="Skills/example.md">inline example</team-skill>.',
    );
    expect(yield* made.service.prepareOutgoingCommand("s", command)).toEqual(command);
    expect(f.graph).toHaveLength(0);
  }),
);

it.effect("does not let an explicit Alpha reference cover an evicted Beta wrapper", () =>
  Effect.gen(function* () {
    const f = teamProjectFixture();
    const made = yield* f.make;
    f.roles[teamB]!.alice = "member";
    yield* made.connect(teamB);
    yield* made.service.execute("s", { action: "bind", teamId: teamB, projectId });
    const beta = (yield* made.service.execute("s", { action: "skill-attach", projectId, path }))
      .reference!;
    yield* made.service.execute("s", { action: "unbind", teamId: teamB, projectId });
    yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
    const alpha = (yield* made.service.execute("s", { action: "skill-attach", projectId, path }))
      .reference!;
    const authority = (yield* made.gate.get(alpha.id))!;
    for (let n = 0; n < 256; n++)
      yield* made.gate.remember({
        ...authority,
        id: NodeCrypto.randomUUID(),
        block: `${authority.block}\nLater issuance ${n}.`,
      });
    expect(yield* made.gate.get(beta.id)).toBeNull();
    const currentAlpha = (yield* made.service.execute("s", {
      action: "skill-attach",
      projectId,
      path,
    })).reference!;
    delete f.roles[teamB]!.alice;
    const result = yield* Effect.result(
      made.service.prepareOutgoingCommand(
        "s",
        dispatch(`${currentAlpha.block}\n\n${beta.block}`, [currentAlpha.id]),
      ),
    );
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("keeps explicit provenance for an edited body with its original source header", () =>
  Effect.gen(function* () {
    const f = teamProjectFixture();
    const made = yield* f.make;
    yield* made.connect(teamA);
    yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
    const reference = (yield* made.service.execute("s", {
      action: "skill-attach",
      projectId,
      path,
    })).reference!;
    const edited = reference.block.replace("Shared note from", "The user edited this body from");
    const prepared = yield* made.service.prepareOutgoingCommand(
      "s",
      dispatch(edited, [reference.id]),
    );
    expect(prepared.type === "message.dispatch" && prepared.text).toBe(edited);
    delete f.roles[teamA]!.alice;
    expect(
      (yield* Effect.result(
        made.gate.verifyBeforeSend({ messageId: "team-gate-message", threadId, text: edited }),
      ))._tag,
    ).toBe("Failure");
  }),
);
