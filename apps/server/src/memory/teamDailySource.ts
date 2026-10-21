/**
 * Daily team memory: what the memory engine asks of the Teams side.
 *
 * The Teams side decides who the author is, which teams they can write to, and which projects in
 * this environment are linked to each team, and it performs every write after checking all of
 * that again. The memory side owns the summaries, the record of what was published, and the
 * schedule (see `teamDailyPass.ts`). Nothing is written to a team unless the Teams side said
 * the author can write to it at that moment.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface TeamDailyWorkspace {
  readonly teamId: string;
  readonly teamName: string;
  /**
   * `ready`: the author can write to the team now. `held`: access couldn't be confirmed, so keep
   * everything and try later. `lost`: access ended, so stop and forget the team's record here.
   */
  readonly access: "ready" | "held" | "lost";
  readonly message?: string;
  /** Projects in this environment linked to the team now, and when sharing started for each. */
  readonly projects: ReadonlyArray<{ readonly projectId: string; readonly sharingSince: string }>;
  /** The team's current folder, as an opaque key; files are only ever updated where written. */
  readonly storageKey: string | null;
}

export type TeamDailyAccount =
  /** The campus account whose work is shared, and every team it has a link or a record for. */
  | {
      readonly kind: "signed-in";
      /** The author folder id: sha256 of `[issuer, subject]`, as the membership service names it. */
      readonly author: string;
      readonly authorName: string;
      readonly workspaces: ReadonlyArray<TeamDailyWorkspace>;
    }
  /** No campus account uses Teams here now, so nothing is shared; records wait, unused. */
  | { readonly kind: "signed-out" }
  /** The account couldn't be checked; keep everything and try later. */
  | { readonly kind: "unavailable"; readonly message: string };

export type TeamDailyWrite =
  | { readonly kind: "written"; readonly etag: string | null; readonly storageKey: string }
  /**
   * Couldn't write now. With `uncertain`, a content mutation was sent and may still land, so its
   * obligation survives until the remote version is known. Otherwise nothing was sent.
   */
  | { readonly kind: "held"; readonly message: string; readonly uncertain?: true }
  /** Nothing was sent, and this exact write can never succeed (too large, folder changed). */
  | { readonly kind: "rejected"; readonly message: string }
  /**
   * Nothing was sent: the file isn't the version this device last wrote, because someone changed
   * it in SharePoint. The day is checked before anything else is done with it.
   */
  | { readonly kind: "changed"; readonly message: string }
  /** Access to the team ended: stop, and write nothing more for it. */
  | { readonly kind: "lost" };

export type TeamDailyInspection =
  | { readonly kind: "file"; readonly text: string; readonly etag: string }
  | { readonly kind: "missing" }
  | { readonly kind: "held"; readonly message: string }
  | { readonly kind: "lost" };

export interface TeamDailyStatus {
  readonly state: "sharing" | "held";
  readonly message: string | null;
  readonly lastPublishedAt: string | null;
}

export interface TeamDailySource {
  /** The author and their teams, given the teams this device still has records for. */
  readonly account: (knownTeamIds: ReadonlyArray<string>) => Effect.Effect<TeamDailyAccount>;
  /**
   * Writes this device's file for a day (`text`), or removes it (`null`), after checking the
   * account and membership again and that every project in `freshProjects` is still linked to
   * the team by the same link (`sharingSince`). `etag` is the version this device last wrote.
   * `storageKey` is the folder the file was written to, or null for the team's current folder; a
   * file is never written anywhere else. `stillShared` is run again immediately before each
   * request that changes the file, including retries; when it answers false the write is
   * abandoned and `held` returned.
   */
  readonly write: (input: {
    readonly teamId: string;
    readonly author: string;
    readonly path: string;
    readonly text: string | null;
    readonly etag: string | null;
    readonly storageKey: string | null;
    readonly freshProjects: ReadonlyArray<{
      readonly projectId: string;
      readonly sharingSince: string;
    }>;
    /** Whether every thread in `text` is still shared. */
    readonly stillShared: Effect.Effect<boolean>;
  }) => Effect.Effect<TeamDailyWrite>;
  /** Reads this device's own file where it was written, to learn whether a write landed. */
  readonly inspect: (input: {
    readonly teamId: string;
    readonly author: string;
    readonly path: string;
    readonly storageKey: string | null;
  }) => Effect.Effect<TeamDailyInspection>;
}

/** The memory side, provided by the DailyMemory layer. */
export class TeamDailyHost extends Context.Service<
  TeamDailyHost,
  {
    /** Makes `source` the one scheduled passes use. */
    readonly attach: (source: TeamDailySource) => Effect.Effect<void>;
    /** Runs a pass now, after any pass in progress. Safe to call often. */
    readonly run: Effect.Effect<void>;
    /** The latest pass's outcome for a team, or null before one finished. */
    readonly status: (teamId: string) => Effect.Effect<TeamDailyStatus | null>;
  }
>()("t3/memory/teamDailySource/TeamDailyHost") {}

/** A host that shares nothing, for Teams services running without memory. */
export const noTeamDailyHost = TeamDailyHost.of({
  attach: () => Effect.void,
  run: Effect.void,
  status: () => Effect.succeed(null),
});
