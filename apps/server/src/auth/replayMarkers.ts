import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import { CLOUD_REPLAY_MARKER_PREFIXES } from "../cloud/CloudLink.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import { DPOP_REPLAY_MARKER_PREFIX } from "./dpop.ts";

const REPLAY_MARKER_PREFIXES = [DPOP_REPLAY_MARKER_PREFIX, ...CLOUD_REPLAY_MARKER_PREFIXES];

/**
 * Persist replay markers beyond proof validity (about 5 minutes DPoP, 7 minutes cloud).
 * Pruning is safe unless wall-clock or filesystem time moves backward by almost a day.
 */
export const REPLAY_MARKER_MAX_AGE = Duration.days(1);

/**
 * Prune only expired marker-prefix .bin files and their stale locks.
 * Never touch other secrets or in-progress .bin.<uuid>.tmp writes.
 */
export const pruneExpiredReplayMarkers = Effect.fn("replayMarkers.pruneExpired")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { secretsDir } = yield* ServerConfig.ServerConfig;
  const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(REPLAY_MARKER_MAX_AGE);
  const entries = yield* fileSystem.readDirectory(secretsDir);
  const isMarkerName = (name: string) =>
    REPLAY_MARKER_PREFIXES.some((prefix) => name.startsWith(prefix));
  const markers = entries.filter((name) => name.endsWith(".bin") && isMarkerName(name));
  const markerSet = new Set(markers);
  const orphanLocks = entries.filter(
    (name) => name.endsWith(".bin.lock") && isMarkerName(name) && !markerSet.has(name.slice(0, -5)),
  );
  const removeIfExpired = (name: string, lockName: string | undefined) => {
    const filePath = path.join(secretsDir, name);
    return fileSystem.stat(filePath).pipe(
      Effect.flatMap((info) =>
        Option.exists(info.mtime, (mtime) => mtime.getTime() < cutoff)
          ? fileSystem
              .remove(filePath)
              .pipe(
                Effect.andThen(
                  lockName === undefined
                    ? Effect.void
                    : fileSystem.remove(path.join(secretsDir, lockName), { force: true }),
                ),
                Effect.as(true),
              )
          : Effect.succeed(false),
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    );
  };
  // `partition` visits every marker, so one locked file does not stop the sweep.
  const [failures, removed] = yield* Effect.partition(
    [
      ...markers.map((name) => [name, `${name}.lock`] as const),
      ...orphanLocks.map((name) => [name, undefined] as const),
    ],
    ([name, lockName]) => removeIfExpired(name, lockName),
  );
  yield* Effect.annotateCurrentSpan({
    "replay_markers.matched": markers.length,
    "replay_markers.removed": removed.filter(Boolean).length,
    "replay_markers.failed": failures.length,
  });
  if (failures.length > 0) {
    yield* Effect.logWarning("Failed to prune some replay markers", {
      failed: failures.length,
      cause: failures[0],
    });
  }
});

/** Prunes expired replay markers after server activation, then every hour. */
export const layer = Layer.effectDiscard(
  forkParked(
    pruneExpiredReplayMarkers().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to prune expired replay markers", { cause }),
      ),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
    ),
  ),
);
