/**
 * Read-only copies of team memory in the memory vault, at `teams/<folder>/`.
 *
 * The Teams side is the source: it decides which teams are copied, checks the
 * user's access, and reads documents through the team's own storage binding.
 * MemorySync owns the disk, the plan, and the schedule, so team copies change
 * only during its passes. A copy whose access ended is removed on the next
 * pass; a team that can't be checked keeps its copy as it was.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface TeamMirrorTeam {
  readonly teamId: string;
  /** The folder name under `teams/`; stable for the life of the copy. */
  readonly folder: string;
}

export type TeamMirrorListing =
  /** Documents to copy, by path inside the team folder, such as `Memory/<author>/<device>/<id>.md`. */
  | {
      readonly kind: "files";
      readonly files: ReadonlyArray<{ readonly path: string; readonly eTag: string }>;
    }
  /** Access ended and the source recorded why: the copy is removed now. */
  | { readonly kind: "detached" }
  /** Access couldn't be checked: the copy is left as it is until a later pass. */
  | { readonly kind: "unavailable" };

export type TeamMirrorDocument =
  | { readonly kind: "file"; readonly text: string; readonly eTag: string }
  /** This document can't be copied now (removed, too large, changed mid-read); try next pass. */
  | { readonly kind: "skip" }
  | Exclude<TeamMirrorListing, { readonly kind: "files" }>;

export type TeamMirrorOutcome =
  | {
      readonly kind: "synced";
      readonly at: string;
      readonly files: number;
      /** Documents that couldn't be copied this pass. */
      readonly skipped: number;
      /** Changed documents left for the next pass by the per-pass download limit. */
      readonly pending: number;
    }
  | { readonly kind: "failed"; readonly message: string };

/** What MemorySync asks of the Teams side. Every call reports its own failures. */
export interface TeamMirrorSource {
  /** Teams that should have a copy now. A copy of any other team is removed. */
  readonly teams: Effect.Effect<ReadonlyArray<TeamMirrorTeam>>;
  readonly list: (teamId: string) => Effect.Effect<TeamMirrorListing>;
  readonly read: (teamId: string, path: string) => Effect.Effect<TeamMirrorDocument>;
  readonly report: (teamId: string, outcome: TeamMirrorOutcome) => Effect.Effect<void>;
}

/** The memory sync engine's side of team copies, provided by the MemorySync layer. */
export class TeamMirrorHost extends Context.Service<
  TeamMirrorHost,
  {
    /** Makes `source` the one the scheduled passes use. */
    readonly attach: (source: TeamMirrorSource) => Effect.Effect<void>;
    /** Removes copies the source no longer lists, then brings the rest up to date. */
    readonly sync: Effect.Effect<void>;
    /** Removes copies the source no longer lists, without reaching the network. */
    readonly prune: Effect.Effect<void>;
  }
>()("t3/memory/sync/teamMirror/TeamMirrorHost") {}

/** Folder names a source may use under `teams/`. */
export const TEAM_MIRROR_FOLDER = /^[a-z0-9][a-z0-9-]{0,62}$/u;

/** A host that keeps no copies, for Teams services running without a memory vault. */
export const noTeamMirrorHost = TeamMirrorHost.of({
  attach: () => Effect.void,
  sync: Effect.void,
  prune: Effect.void,
});
