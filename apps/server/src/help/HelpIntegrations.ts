import type { IntegrationsListResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** An observational port over the application-owned integration registry's cached snapshot. */
export class HelpIntegrations extends Context.Service<
  HelpIntegrations,
  { readonly snapshot: Effect.Effect<IntegrationsListResult | undefined> }
>()("t3/help/HelpIntegrations") {}

/** The application boundary supplies the existing registry; Help never acquires or refreshes it. */
export const layerFromSnapshot = (read: () => Promise<IntegrationsListResult | undefined>) =>
  Layer.sync(HelpIntegrations, () =>
    HelpIntegrations.of({
      snapshot: Effect.tryPromise(read).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
        Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(undefined) }),
      ),
    }),
  );
