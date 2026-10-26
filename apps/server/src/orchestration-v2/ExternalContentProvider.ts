import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

import * as ExternalContent from "../integrations/ExternalContent.ts";

/** Guard history delivery as well as tool callbacks; changing providers cannot erase exposure. */
export const protectAdapter = Effect.fn("ExternalContentProvider.protectAdapter")(function* (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
) {
  const content = yield* ExternalContent.ExternalContent;
  return {
    ...adapter,
    openSession: (input) =>
      (adapter.openExternalContentSession
        ? Effect.void
        : content
            .revoke(`thread:${input.threadId}`)
            .pipe(Effect.andThen(content.assertUnexposed(`thread:${input.threadId}`)))
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: adapter.driver,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
        Effect.andThen(() => (adapter.openExternalContentSession ?? adapter.openSession)(input)),
        Effect.tap((runtime) =>
          adapter.openExternalContentSession
            ? content
                .assertInference(
                  {
                    ownerId: `thread:${input.threadId}`,
                    providerSessionId: runtime.providerSessionId,
                    providerInstanceId: runtime.instanceId,
                  },
                  true,
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterOpenSessionError({
                        driver: adapter.driver,
                        providerSessionId: input.providerSessionId,
                        cause,
                      }),
                  ),
                )
            : Effect.void,
        ),
        Effect.map((runtime): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
          const owners = new Set([`thread:${input.threadId}`]);
          const caller = (ownerId: string) => ({
            ownerId,
            providerSessionId: runtime.providerSessionId,
            providerInstanceId: runtime.instanceId,
          });
          const guard = (threadId: string | null | undefined) => {
            const ownerId = `thread:${threadId ?? input.threadId}`;
            owners.add(ownerId);
            return content.assertInference(caller(ownerId)).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: adapter.driver,
                    detail:
                      "This conversation contains external content and requires a verified integration-only runtime. Its history and next action were withheld.",
                    cause,
                  }),
              ),
            );
          };
          return {
            ...runtime,
            ensureThread: (next) =>
              guard(next.threadId).pipe(Effect.andThen(() => runtime.ensureThread(next))),
            resumeThread: (next) =>
              guard(next.threadId ?? next.providerThread.appThreadId).pipe(
                Effect.andThen(() => runtime.resumeThread(next)),
              ),
            startTurn: (next) =>
              guard(next.threadId).pipe(Effect.andThen(() => runtime.startTurn(next))),
            steerTurn: (next) =>
              guard(next.threadId).pipe(Effect.andThen(() => runtime.steerTurn(next))),
            ...(runtime.compactThread === undefined
              ? {}
              : {
                  compactThread: (next) =>
                    guard(next.threadId).pipe(Effect.andThen(() => runtime.compactThread!(next))),
                }),
            ...(runtime.injectHistory === undefined
              ? {}
              : {
                  injectHistory: (next) =>
                    guard(next.providerThread.appThreadId).pipe(
                      Effect.andThen(() => runtime.injectHistory!(next)),
                    ),
                }),
            forkThread: (next) =>
              content
                .assertUnexposed(
                  `thread:${next.sourceProviderThread.appThreadId ?? input.threadId}`,
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: adapter.driver,
                        detail:
                          "External-content history cannot be forked without a host-bound inherited runtime ceiling.",
                        cause,
                      }),
                  ),
                  Effect.andThen(guard(next.targetThreadId)),
                  Effect.andThen(() => runtime.forkThread(next)),
                ),
            respondToRuntimeRequest: (next) =>
              Effect.forEach(owners, (ownerId) => guard(ownerId.slice("thread:".length)), {
                discard: true,
              }).pipe(Effect.andThen(() => runtime.respondToRuntimeRequest(next))),
          };
        }),
      ),
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
});
