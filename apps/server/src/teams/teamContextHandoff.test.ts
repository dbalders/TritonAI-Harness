import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  RunAttemptId,
  RunId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TeamMessageGate from "./TeamMessageGate.ts";
import * as TeamContextHandoff from "./teamContextHandoff.ts";
import {
  deviceId,
  identityOf,
  projectId,
  recordId,
  teamA,
  teamProjectFixture,
  threadId,
} from "./testing/teamProjectFixture.ts";

it.effect.each([false, true])(
  "withholds refused team text from recovery while retaining accepted history: accepted=%s",
  (accepted) =>
    Effect.gen(function* () {
      const f = teamProjectFixture();
      const made = yield* f.make;
      yield* made.connect(teamA);
      yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
      const reference = (yield* made.service.execute("s", {
        action: "skill-attach",
        projectId,
        path: `Skills/${identityOf("alice")}/${deviceId}/${recordId}.md`,
      })).reference!;
      const messageId = MessageId.make("refused-user-message");
      const runId = RunId.make("refused-run");
      const attemptId = RunAttemptId.make("refused-attempt");
      const nodeId = NodeId.make("refused-root-node");
      const text = "Confidential edited team instructions.";
      yield* made.service.prepareOutgoingCommand("s", {
        type: "message.dispatch",
        dispatchMode: { type: "queue_after_active" },
        commandId: CommandId.make("prepare-refused-message"),
        messageId,
        threadId,
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        teamReferences: [reference.id],
      });
      delete f.roles[teamA]!.alice;
      const history = {
        role: "user",
        kind: "user_message",
        text,
        threadId,
        runId,
        itemId: TurnItemId.make("refused-item"),
        providerThreadId: null,
        status: "completed",
        runStatus: "failed",
      } as const;
      const handoff = {
        summaryText: text,
        history: { messages: [history], coverage: "Recovered history", omittedItems: 0 },
      } as unknown as OrchestrationV2ContextHandoff;
      const filter = yield* TeamContextHandoff.makeFilter.pipe(
        Effect.provideService(TeamMessageGate.TeamMessageGate, made.gate),
        Effect.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: () =>
              Effect.succeed({
                runs: [{ id: runId, status: "failed", userMessageId: messageId }],
                messages: [{ id: messageId, runId, nodeId, role: "user", text }],
                turnItems: [
                  {
                    id: history.itemId,
                    runId,
                    nodeId,
                    ordinal: 0,
                    type: "user_message",
                    messageId,
                  },
                ],
                attempts: [{ id: attemptId, runId, rootNodeId: nodeId }],
                providerTurns: accepted
                  ? [
                      {
                        runAttemptId: attemptId,
                        nativeTurnRef: { nativeId: "accepted" },
                        startedAt: null,
                      },
                    ]
                  : [],
              } as never),
          }),
        ),
      );
      const [filtered] = yield* filter([handoff]);
      expect(filtered!.history!.messages).toHaveLength(accepted ? 1 : 0);
      expect(filtered!.summaryText.includes(text)).toBe(accepted);
    }),
);

it.effect.each([
  { runStatus: "running", rootAccepted: true, accessEnded: true },
  { runStatus: "completed", rootAccepted: true, accessEnded: true },
  { runStatus: "failed", rootAccepted: true, accessEnded: true },
  { runStatus: "failed", rootAccepted: false, accessEnded: true },
  { runStatus: "failed", rootAccepted: true, accessEnded: false },
  { runStatus: "failed", rootAccepted: true, accessEnded: true, restart: true },
])(
  "checks steering separately from its root: run=$runStatus accepted=$rootAccepted accessEnded=$accessEnded restart=$restart",
  ({ runStatus, rootAccepted, accessEnded, restart = false }) =>
    Effect.gen(function* () {
      const f = teamProjectFixture();
      const made = yield* f.make;
      yield* made.connect(teamA);
      yield* made.service.execute("s", { action: "bind", teamId: teamA, projectId });
      const reference = (yield* made.service.execute("s", {
        action: "skill-attach",
        projectId,
        path: `Skills/${identityOf("alice")}/${deviceId}/${recordId}.md`,
      })).reference!;
      const rootId = MessageId.make("accepted-root-message");
      const steeringId = MessageId.make("protected-steering-message");
      const runId = RunId.make("steered-run");
      const attemptId = RunAttemptId.make("accepted-root-attempt");
      const rootNodeId = NodeId.make("accepted-root-node");
      const steeringNodeId = restart ? NodeId.make("unaccepted-restart-node") : rootNodeId;
      const rootText = restart
        ? "Confidential earlier team root instructions."
        : "An ordinary first question.";
      const steeringText = "Confidential team steering instructions.";
      if (restart)
        yield* made.service.prepareOutgoingCommand("s", {
          type: "message.dispatch",
          dispatchMode: { type: "queue_after_active" },
          commandId: CommandId.make("prepare-protected-root-message"),
          messageId: rootId,
          threadId,
          text: rootText,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          teamReferences: [reference.id],
        });
      yield* made.service.prepareOutgoingCommand("s", {
        type: "message.dispatch",
        dispatchMode: { type: "queue_after_active" },
        commandId: CommandId.make("prepare-protected-steering-message"),
        messageId: steeringId,
        threadId,
        text: steeringText,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        teamReferences: [reference.id],
      });
      if (accessEnded) delete f.roles[teamA]!.alice;
      const rootItemId = TurnItemId.make("accepted-root-item");
      const steeringItemId = TurnItemId.make("protected-steering-item");
      const history = [
        { itemId: rootItemId, text: rootText },
        { itemId: steeringItemId, text: steeringText },
      ].map((message) => ({
        ...message,
        role: "user",
        kind: "user_message",
        threadId,
        runId,
        providerThreadId: null,
        status: "completed",
        runStatus,
      }));
      const handoff = {
        summaryText: `${rootText}\n${steeringText}`,
        history: {
          messages: history,
          coverage: "Recovered history",
          omittedItems: 1,
          omittedItemIds: [TurnItemId.make("previously-omitted-item")],
        },
      } as unknown as OrchestrationV2ContextHandoff;
      const filter = yield* TeamContextHandoff.makeFilter.pipe(
        Effect.provideService(TeamMessageGate.TeamMessageGate, made.gate),
        Effect.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: (_threadId, collections, filters) => {
              expect(collections).toContain("turnItems");
              expect(filters).toMatchObject({
                runIds: [runId],
                messageRunIds: [runId],
                messageRoles: ["user"],
                turnItemRunIds: [runId],
                turnItemTypes: ["user_message"],
              });
              return Effect.succeed({
                runs: [
                  {
                    id: runId,
                    status: runStatus,
                    userMessageId: restart ? steeringId : rootId,
                  },
                ],
                messages: [
                  { id: rootId, runId, nodeId: rootNodeId, role: "user", text: rootText },
                  {
                    id: steeringId,
                    runId,
                    nodeId: steeringNodeId,
                    role: "user",
                    text: steeringText,
                  },
                ],
                turnItems: [
                  {
                    id: rootItemId,
                    runId,
                    nodeId: rootNodeId,
                    ordinal: 0,
                    type: "user_message",
                    messageId: rootId,
                  },
                  {
                    id: steeringItemId,
                    runId,
                    nodeId: steeringNodeId,
                    ordinal: 1,
                    type: "user_message",
                    messageId: steeringId,
                    // These fields are persisted before steering delivery is attempted.
                    status: "completed",
                    providerTurnId: "accepted-root-provider-turn",
                  },
                ],
                attempts: [
                  { id: attemptId, runId, rootNodeId },
                  ...(restart
                    ? [
                        {
                          id: RunAttemptId.make("unaccepted-restart-attempt"),
                          runId,
                          rootNodeId: steeringNodeId,
                        },
                      ]
                    : []),
                ],
                providerTurns: rootAccepted
                  ? [
                      {
                        runAttemptId: attemptId,
                        nativeTurnRef: { nativeId: "accepted" },
                        startedAt: null,
                      },
                    ]
                  : [],
              } as never);
            },
          }),
        ),
      );
      const [filtered] = yield* filter([handoff]);
      expect(filtered!.history!.messages.map((message) => message.itemId)).toEqual(
        accessEnded ? [rootItemId] : [rootItemId, steeringItemId],
      );
      expect(filtered!.summaryText).toContain(rootText);
      expect(filtered!.summaryText.includes(steeringText)).toBe(!accessEnded);
      expect(filtered!.history!.omittedItems).toBe(accessEnded ? 2 : 1);
      expect(filtered!.history!.omittedItemIds).toEqual([
        TurnItemId.make("previously-omitted-item"),
        ...(accessEnded ? [steeringItemId] : []),
      ]);
    }),
);
