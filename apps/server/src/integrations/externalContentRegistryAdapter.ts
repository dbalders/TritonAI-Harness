import * as Effect from "effect/Effect";
import * as ExternalContent from "./ExternalContent.ts";

/** Bridge the application's Effect service into the registry's existing Promise API. */
export const makeExternalContentRegistry = Effect.fn("makeExternalContentRegistry")(function* () {
  const service = yield* ExternalContent.ExternalContent;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  return {
    admit: (caller, toolName, channel) => runPromise(service.admit(caller, toolName, channel)),
    record: (invocation, source, result) => runPromise(service.record(invocation, source, result)),
  } satisfies ExternalContent.ExternalContentRegistry;
});
