import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
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
                messages: [{ id: messageId, text }],
                attempts: [{ id: attemptId, runId }],
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
