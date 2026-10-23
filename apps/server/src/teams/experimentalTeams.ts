/** Internal privacy work can remove prior sharing while the experiment is paused. */
import { TeamsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { ServerSettingsService } from "../serverSettings.ts";

// No RPC accepts this authority. Callers may use it only for access checks and
// withdrawals of content already shared, never to add new shared content.
class PrivacyCleanup extends Context.Reference<boolean>("t3/teams/PrivacyCleanup", {
  defaultValue: () => false,
}) {}

export const withPrivacyCleanup = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(PrivacyCleanup, true));

/** Capture the service, then read its latest value at each side-effect boundary. */
export const makeAccess = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  // Unreadable settings cannot silently turn an experiment on.
  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.experimentalTeamsEnabled === true),
    Effect.orElseSucceed(() => false),
  );
  const requireEnabled = enabled.pipe(
    Effect.flatMap((on) =>
      on
        ? Effect.void
        : Effect.fail(
            new TeamsError({
              code: "forbidden",
              message: "Teams is turned off. Turn it on in Settings → Experimental to continue.",
            }),
          ),
    ),
  );
  const requireRead = PrivacyCleanup.pipe(
    Effect.flatMap((cleanup) => (cleanup ? Effect.void : requireEnabled)),
  );
  return { enabled, requireEnabled, requireRead };
});
