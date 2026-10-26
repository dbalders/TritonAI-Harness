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
import * as ExternalContent from "../integrations/ExternalContent.ts";
import * as ServerConfig from "../config.ts";

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
  | "generateDailyMemory"
  | "generateIdeas"
  | "generateReviewGuide"
  | "generateHelp";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  content: ExternalContent.ExternalContent["Service"],
  promptOnlyRuntimeAvailable: boolean,
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap(
      Effect.fn("TextGeneration.selectRuntime")(function* (instance) {
        if (!instance)
          return yield* new TextGenerationError({
            operation,
            detail: `No provider instance registered for id '${instanceId}'.`,
          });
        const exposed = yield* content.hasExposure.pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "External-content history could not be checked. Generation was withheld.",
                cause,
              }),
          ),
        );
        // Helper inputs also include copied and summarized history without a single owning thread.
        // An environment-wide marker prevents those paths from silently restoring a coding CLI.
        if (exposed && (instance.driverKind !== "codex" || !promptOnlyRuntimeAvailable))
          return yield* new TextGenerationError({
            operation,
            detail:
              "This environment contains integration content. Text generation requires a Codex model with the verified prompt-only runtime.",
          });
        return instance.textGeneration;
      }),
    ),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const content = yield* ExternalContent.ExternalContent;
  const config = yield* ServerConfig.ServerConfig;
  return TextGeneration.of({
    generateHelp: (input) =>
      resolveInstance(
        registry,
        content,
        Boolean(config.integrationCodexRuntime),
        "generateHelp",
        input.modelSelection.instanceId,
      ).pipe(
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
    generateCommitMessage: (input) =>
      resolveInstance(
        registry,
        content,
        Boolean(config.integrationCodexRuntime),
        "generateCommitMessage",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input))),
    generatePrContent: (input) =>
      resolveInstance(
        registry,
        content,
        Boolean(config.integrationCodexRuntime),
        "generatePrContent",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input))),
    generateBranchName: (input) =>
      resolveInstance(
        registry,
        content,
        Boolean(config.integrationCodexRuntime),
        "generateBranchName",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input))),
    generateReviewGuide: (input) =>
      resolveInstance(
        registry,
        content,
        Boolean(config.integrationCodexRuntime),
        "generateReviewGuide",
        input.modelSelection.instanceId,
      ).pipe(Effect.flatMap((textGeneration) => textGeneration.generateReviewGuide(input))),
    generateThreadTitle: (input) =>
      resolveInstance(
        registry,
        content,
        Boolean(config.integrationCodexRuntime),
        "generateThreadTitle",
        input.modelSelection.instanceId,
      ).pipe(
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
      ),
    generateDailyMemory: (input) =>
      resolveInstance(
        registry,
        content,
        Boolean(config.integrationCodexRuntime),
        "generateDailyMemory",
        input.modelSelection.instanceId,
      ).pipe(
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
    generateIdeas: (input) =>
      resolveInstance(
        registry,
        content,
        Boolean(config.integrationCodexRuntime),
        "generateIdeas",
        input.modelSelection.instanceId,
      ).pipe(
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
  });
});

export const layer = Layer.effect(TextGeneration, make).pipe(Layer.provide(ExternalContent.layer));
