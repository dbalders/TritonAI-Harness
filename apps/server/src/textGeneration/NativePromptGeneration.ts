import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ExternalContent from "../integrations/ExternalContent.ts";
import * as Native from "../provider/IntegrationCodexRuntime.ts";
import { buildCodexInitializeParams } from "../provider/CodexProvider.ts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import {
  decodeJsonReply,
  type Operation as BaseOperation,
} from "@t3tools/provider-core/server/textGenerationOperations";

type Operation = BaseOperation | "generateDailyMemory" | "generateIdeas";
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

/** Use the same pinned native dispatch ceiling as integration sessions, with no callbacks at all. */
export const run = Effect.fn("NativePromptGeneration.run")(function* <S extends Schema.Top>(input: {
  readonly operation: Operation;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  readonly environment: NodeJS.ProcessEnv;
  readonly configArgs: ReadonlyArray<string>;
  readonly imagePaths?: ReadonlyArray<string>;
  readonly timeoutMs: number;
}) {
  const content = yield* ExternalContent.ExternalContent;
  const crypto = yield* Crypto.Crypto;
  const requestId = yield* crypto.randomUUIDv4();
  const caller = {
    ownerId: `generation:${requestId}`,
    providerSessionId: requestId,
    providerInstanceId: input.modelSelection.instanceId,
  };
  const operation = Effect.gen(function* () {
    const client = yield* Native.open({
      caller,
      nativeTools: [],
      allowedTools: [],
      expiresAt: (yield* Clock.currentTimeMillis) + input.timeoutMs,
      environment: input.environment,
      configArgs: input.configArgs,
    });
    let threadId: string | undefined;
    let reply = "";
    const completed = yield* Deferred.make<string, TextGenerationError>();
    yield* client.handleServerNotification("item/completed", (event) => {
      if (event.threadId !== threadId || event.item.type !== "agentMessage") return Effect.void;
      const text = event.item.text;
      if (new TextEncoder().encode(text).byteLength > MAX_REPLY_BYTES)
        return Deferred.fail(
          completed,
          new TextGenerationError({
            operation: input.operation,
            detail: "Prompt-only generation returned too much text.",
          }),
        ).pipe(Effect.asVoid);
      return Effect.sync(() => {
        reply = text;
      });
    });
    yield* client.handleServerNotification("turn/completed", (event) => {
      if (event.threadId !== threadId) return Effect.void;
      return (
        event.turn.status === "completed"
          ? Deferred.succeed(completed, reply)
          : Deferred.fail(
              completed,
              new TextGenerationError({
                operation: input.operation,
                detail: "Prompt-only generation did not complete.",
              }),
            )
      ).pipe(Effect.asVoid);
    });
    yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.raw.notify("initialized");
    const started = yield* client.request("thread/start", {
      model: input.modelSelection.model,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: "Return structured text using only the supplied prompt. You have no tools.",
    });
    threadId = started.thread.id;
    yield* content.assertInference(caller, true, client);
    yield* client.request("turn/start", {
      threadId,
      input: [
        { type: "text", text: input.prompt },
        ...(input.imagePaths ?? []).map((path) => ({ type: "localImage" as const, path })),
      ],
      outputSchema: yield* decodeJson(toJsonSchemaObject(input.outputSchema)),
    });
    const text = yield* Deferred.await(completed);
    return yield* decodeJsonReply(input, "codex", text);
  });
  return yield* operation.pipe(
    Effect.scoped,
    Effect.timeout(input.timeoutMs),
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: input.operation,
          detail:
            "The verified prompt-only runtime could not complete this generation. No coding runtime was substituted.",
          cause,
        }),
    ),
    Effect.ensuring(content.revoke(caller.ownerId)),
  );
});
