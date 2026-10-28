import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  DailyMemoryGenerationInput,
  DailyMemoryGenerationResult,
  IdeasGenerationInput,
  IdeasGenerationResult,
  GeneratedIdea,
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateDailyMemory"
  | "generateIdeas"
  | "generateHelp";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  return TextGeneration.of({
    generateHelp: Effect.fn("TextGeneration.generateHelp")((input) =>
      resolveInstance(registry, "generateHelp", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateHelp
            ? textGeneration.generateHelp(input)
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateHelp",
                  detail: "The configured provider does not support Help text generation.",
                }),
              ),
        ),
      ),
    ),
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return resolveInstance(
        registry,
        "generateCommitMessage",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)));
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return resolveInstance(registry, "generateReviewGuide", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input)),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
          }),
        ),
      );
    }),
    generateDailyMemory: Effect.fn("TextGeneration.generateDailyMemory")((input) =>
      resolveInstance(registry, "generateDailyMemory", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateDailyMemory
            ? textGeneration.generateDailyMemory(input)
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateDailyMemory",
                  detail:
                    "Daily memory needs a Codex text generation model. Choose one under Settings, Text generation.",
                }),
              ),
        ),
      ),
    ),
    generateIdeas: Effect.fn("TextGeneration.generateIdeas")((input) =>
      resolveInstance(registry, "generateIdeas", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateIdeas
            ? textGeneration.generateIdeas(input)
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateIdeas",
                  detail:
                    "Ideas need a Codex text generation model. Choose one under Settings, Text generation.",
                }),
              ),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
