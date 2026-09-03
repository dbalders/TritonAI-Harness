import {
  ServerTritonAiCommonsError,
  type ProviderInstanceId,
  type ServerSubmitProviderSkillToTritonAiCommonsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as Integrations from "../integrations/IntegrationRegistry.ts";
import * as CodexManagement from "./CodexManagement.ts";
import { submitProviderSkillToTritonAiCommons } from "./tritonAiCommons.ts";
import { recordTritonAiCommonsSubmissionReceipt } from "./tritonAiCommonsReceipts.ts";

export interface TritonAiCommonsSkillSelection {
  readonly instanceId: ProviderInstanceId;
  readonly skillPath?: string;
  readonly skillName?: string;
  readonly confirmedPublicShare: true;
}

const isCommonsError = Schema.is(ServerTritonAiCommonsError);
const commonsSubmissionSemaphore = Semaphore.makeUnsafe(1);

export function submitInstalledProviderSkillToTritonAiCommons(
  input: TritonAiCommonsSkillSelection,
) {
  return commonsSubmissionSemaphore.withPermits(1)(
    CodexManagement.loadProviderSkillForCommonsSubmission(input).pipe(
      Effect.flatMap(({ bundle, skillPath }) => {
        const registry = Integrations.getIntegrationRegistryOptional();
        if (!registry) {
          return Effect.fail(
            new ServerTritonAiCommonsError({
              code: "github_setup_required",
              message:
                "GitHub submission is unavailable. Open Settings > Plugins > GitHub, install or enable the plugin, connect your account, then retry.",
            }),
          );
        }
        return Effect.tryPromise({
          try: (signal) => submitProviderSkillToTritonAiCommons({ bundle, registry, signal }),
          catch: (error) =>
            isCommonsError(error)
              ? error
              : new ServerTritonAiCommonsError({
                  code: "submission_failed",
                  message:
                    "TritonAI Commons submission failed before a review could be opened. Retry or reconnect GitHub in Settings > Plugins.",
                  cause: error,
                }),
        }).pipe(
          Effect.tap((result) =>
            Effect.gen(function* () {
              const config = yield* ServerConfig.ServerConfig;
              yield* recordTritonAiCommonsSubmissionReceipt({
                stateDir: config.stateDir,
                skillPath,
                result,
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerTritonAiCommonsError({
                      code: "submission_failed",
                      message:
                        "The pull request was opened, but Harness could not save its local Shared with UCSD status. Retry the share; Harness will verify and reuse the existing pull request without creating a duplicate.",
                      cause,
                    }),
                ),
              );
            }),
          ),
        );
      }),
    ),
  );
}

export interface TritonAiCommonsActionRuntime {
  readonly submit: (
    input: TritonAiCommonsSkillSelection,
    signal: AbortSignal,
  ) => Promise<ServerSubmitProviderSkillToTritonAiCommonsResult>;
}

let activeRuntime: TritonAiCommonsActionRuntime | null = null;

type EffectRequirements<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never;
type SubmissionRequirements = EffectRequirements<
  ReturnType<typeof submitInstalledProviderSkillToTritonAiCommons>
>;

export function getTritonAiCommonsActionRuntimeOptional(): TritonAiCommonsActionRuntime | null {
  return activeRuntime;
}

export const runtimeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const context = yield* Effect.context<SubmissionRequirements>();
    const runPromise = Effect.runPromiseWith(context);
    const runtime: TritonAiCommonsActionRuntime = {
      submit: (input, signal) =>
        runPromise(submitInstalledProviderSkillToTritonAiCommons(input), { signal }),
    };
    activeRuntime = runtime;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (activeRuntime === runtime) activeRuntime = null;
      }),
    );
  }),
);
