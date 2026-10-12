/**
 * Local copies of team memory: which teams this environment copies into the memory vault, and
 * the access checks MemorySync's passes make before copying anything (see `teamMirror.ts`).
 *
 * Every team the environment's Teams account belongs to gets a copy, read through that account's
 * own session and the team's current folder. A copy holds the team's daily memory, memory notes,
 * and SOPs; skills reach agents only through the per-project approval in Settings → Skills. The
 * first pass after access ends (sign-out, another account, removal from the team, the team
 * archived, or Graph refusing the folder) removes the copy and keeps a detached record so the
 * Teams page can say why. A check that fails for another reason keeps the copy as it is.
 *
 * Daily memory grows by a file per member each day, too much to list in full every few minutes.
 * Each pass lists every member's recent months, plus any older month a member's change marker
 * says changed since this copy last listed it; everything else is listed at most once a day.
 * Months not listed in a pass are left exactly as they are.
 */
import {
  type AccountStatus,
  type TeamMemoryMirror,
  type TeamStorage,
  TeamsError,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { AccountService } from "../auth/AccountService.ts";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { localDayAt } from "../memory/memoryDays.ts";
import type {
  TeamMirrorHost,
  TeamMirrorListing,
  TeamMirrorOutcome,
  TeamMirrorSource,
} from "../memory/sync/teamMirror.ts";
import { isTeamDailyPath, teamDailyMarkerAuthor, TeamDailyMarker } from "../memory/teamDaily.ts";
import { isTeamDocumentPath } from "./teamDocuments.ts";
import type { TeamStorageService } from "./TeamStorageService.ts";

const SECRET_NAME = "team-memory-mirrors";
const MAX_MIRRORS = 100;
/** The folders copied. Skills stay out: an agent gets one only after per-project approval. */
const ROOTS = ["Memory", "SOPs"] as const;
/** How often every month of daily memory is listed, to catch changes made directly in SharePoint. */
const FULL_DAILY_LISTING_MS = 24 * 60 * 60_000;
const Mirror = Schema.Struct({
  teamId: Schema.String,
  teamName: Schema.String,
  folder: Schema.String,
  /** The app session whose campus and Microsoft sign-in the copy is read with. */
  sessionId: Schema.String,
  /** sha256 of `[issuer, subject]`, as the membership service names author folders. */
  identity: Schema.String,
  since: Schema.String,
  /** The user stopped this copy; it stays off until they keep it again. */
  off: Schema.optionalKey(Schema.Literal(true)),
  detached: Schema.optionalKey(Schema.Struct({ reason: Schema.String, at: Schema.String })),
});
type Mirror = typeof Mirror.Type;
const Mirrors = Schema.fromJsonString(Schema.Array(Mirror).check(Schema.isMaxLength(MAX_MIRRORS)));
const decodeMirrors = Schema.decodeUnknownEffect(Mirrors);
const encodeMirrors = Schema.encodeEffect(Mirrors);
const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(TeamDailyMarker));

export const identityOf = (profile: { issuer: string; subject: string }) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([profile.issuer, profile.subject]))
    .digest("base64url");

/** A readable folder name that stays with the copy when the team is renamed. */
const mirrorFolder = (teamId: string, teamName: string) => {
  const slug = teamName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  const suffix = NodeCrypto.createHash("sha256").update(teamId).digest("hex").slice(0, 6);
  return `${slug || "team"}-${suffix}`;
};

const failure = (message: string) => new TeamsError({ code: "unavailable", message });
const reasons = {
  signedOut: "You signed out of UC San Diego, so the local copy was removed.",
  otherAccount: "A different UC San Diego account signed in, so the local copy was removed.",
  lostTeam: "You no longer have access to this team, so the local copy was removed.",
  archived: "The team was archived, so the local copy was removed.",
  lostFolder: "The team's folder is no longer available to you, so the local copy was removed.",
} as const;

const RESTARTABLE = new Set<string>([reasons.signedOut, reasons.otherAccount, reasons.lostTeam]);

/** The campus session and identity that share and copy team memory in this environment. */
export interface TeamMemoryAccount {
  readonly sessionId: string;
  readonly identity: string;
  /** When this identity became the Teams account here; its work is shared from then on. */
  readonly since?: string;
}

/** What a copy has seen of each member's daily memory, for this server's life. */
interface DailySeen {
  lastFullAt: number;
  /** `<author>/<YYYY-MM>` to the change-marker stamp when it was last listed. */
  readonly months: Map<string, string>;
  /** A listing's months, kept until MemorySync reports the copy matched them. */
  pending: { full: boolean; at: number; months: Map<string, string> } | null;
}

export const makeTeamMemoryMirror = (input: {
  readonly account: AccountService["Service"];
  readonly storage: TeamStorageService["Service"];
  readonly secrets: ServerSecretStore["Service"];
  readonly host: TeamMirrorHost["Service"];
  /** The account team memory uses here, or null when no account uses Teams here. */
  readonly memoryAccount: Effect.Effect<TeamMemoryAccount | null, TeamsError>;
}) =>
  Effect.gen(function* () {
    const { account, storage, secrets, host } = input;
    const lock = yield* Semaphore.make(1);
    /** Sync progress by team, kept for this server's life. */
    const progress = new Map<string, { lastSyncedAt: string | null; message: string | null }>();
    /** Each copied team's folder as last checked, so documents are read from the same root. */
    const roots = new Map<string, TeamStorage>();
    const daily = new Map<string, DailySeen>();

    const read = secrets.get(SECRET_NAME).pipe(
      Effect.flatMap((value) =>
        Option.isSome(value)
          ? decodeMirrors(new TextDecoder().decode(value.value))
          : Effect.succeed([] as readonly Mirror[]),
      ),
      Effect.mapError(() => failure("Local team copies could not be read securely.")),
    );
    const write = (mirrors: readonly Mirror[]) =>
      encodeMirrors(mirrors).pipe(
        Effect.flatMap((encoded) => secrets.set(SECRET_NAME, new TextEncoder().encode(encoded))),
        Effect.mapError(() => failure("Local team copies could not be saved securely.")),
      );
    const update = (change: (mirrors: readonly Mirror[]) => readonly Mirror[]) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* read;
          const next = change(current);
          if (next !== current) yield* write(next);
          return next;
        }),
      );
    const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const forget = (teamId: string) =>
      Effect.sync(() => {
        progress.delete(teamId);
        roots.delete(teamId);
        daily.delete(teamId);
      });
    /** Marks matching copies detached; the next pass or prune removes their folders. */
    const detachWhere = (matches: (mirror: Mirror) => boolean, reason: string) =>
      Effect.gen(function* () {
        const at = yield* now;
        const next = yield* update((mirrors) =>
          mirrors.some((mirror) => !mirror.detached && matches(mirror))
            ? mirrors.map((mirror) =>
                !mirror.detached && matches(mirror)
                  ? { ...mirror, detached: { reason, at } }
                  : mirror,
              )
            : mirrors,
        );
        for (const mirror of next) if (mirror.detached) yield* forget(mirror.teamId);
      });
    const active = (teamId: string) =>
      read.pipe(
        Effect.map((mirrors) => mirrors.find((m) => m.teamId === teamId && !m.detached && !m.off)),
      );

    const toContract = (mirror: Mirror): TeamMemoryMirror => {
      const state = progress.get(mirror.teamId);
      return {
        teamId: mirror.teamId,
        teamName: mirror.teamName,
        folder: `teams/${mirror.folder}`,
        state: mirror.detached ? "detached" : mirror.off ? "off" : "mirrored",
        lastSyncedAt: mirror.detached || mirror.off ? null : (state?.lastSyncedAt ?? null),
        message: mirror.detached?.reason ?? (mirror.off ? null : (state?.message ?? null)),
      };
    };
    const note = (teamId: string, message: string) =>
      Effect.sync(() => {
        progress.set(teamId, {
          lastSyncedAt: progress.get(teamId)?.lastSyncedAt ?? null,
          message,
        });
      });

    /**
     * The copy's campus session as it stands now: detached when it signed out or another account
     * signed in, null when it couldn't be checked.
     */
    const checkSession = (mirror: Mirror) =>
      Effect.gen(function* () {
        const status = yield* account.getStatus(mirror.sessionId).pipe(Effect.result);
        if (status._tag === "Failure") {
          yield* note(
            mirror.teamId,
            "Your UC San Diego account couldn't be checked. Harness will try again.",
          );
          return "unavailable" as const;
        }
        const current: AccountStatus = status.success;
        if (current.status !== "signed-in" || !current.profile) {
          yield* detachWhere((m) => m.teamId === mirror.teamId, reasons.signedOut);
          return "detached" as const;
        }
        if (identityOf(current.profile) !== mirror.identity) {
          yield* detachWhere((m) => m.teamId === mirror.teamId, reasons.otherAccount);
          return "detached" as const;
        }
        return "current" as const;
      });

    /** The team's current folder, after membership and the session are checked. */
    const checkAccess = (mirror: Mirror) =>
      Effect.gen(function* () {
        const session = yield* checkSession(mirror);
        if (session !== "current") return session;
        const detach = (reason: string) =>
          detachWhere((m) => m.teamId === mirror.teamId, reason).pipe(
            Effect.as("detached" as const),
          );
        const result = yield* account
          .teams(mirror.sessionId, { action: "get", teamId: mirror.teamId })
          .pipe(Effect.result);
        if (result._tag === "Failure") {
          if (result.failure.code === "not_found" || result.failure.code === "forbidden")
            return yield* detach(reasons.lostTeam);
          yield* note(mirror.teamId, result.failure.message);
          return "unavailable" as const;
        }
        const team = result.success.team;
        if (!team || team.id !== mirror.teamId) return yield* detach(reasons.lostTeam);
        if (team.state === "archived") return yield* detach(reasons.archived);
        if (team.state !== "ready" || !team.storage) {
          yield* note(mirror.teamId, "The team's private folder is not ready.");
          return "unavailable" as const;
        }
        roots.set(mirror.teamId, team.storage);
        return team.storage;
      });

    const storageProblem = (error: TeamsError) =>
      error.code === "sign_in_required"
        ? "Reconnect Microsoft in Teams → your team → Shared storage to keep this copy up to date."
        : error.message;
    const disconnected = (status: string) =>
      status === "not-configured"
        ? "Microsoft storage is not set up for this environment yet."
        : "Connect Microsoft in Teams → your team → Shared storage to keep this copy up to date.";

    type Listed =
      | { readonly kind: "files"; readonly files: ReadonlyArray<{ path: string; etag: string }> }
      | { readonly kind: "detached" | "unavailable" };
    /** Lists one folder of the team for a copy; a refused folder detaches the copy. */
    const listFolder = (
      mirror: Mirror,
      folder: TeamStorage,
      root: (typeof ROOTS)[number] | "Daily",
      descend?: (path: string) => boolean,
      skipped?: string[],
    ) =>
      Effect.gen(function* () {
        const listed = yield* storage
          .execute(
            mirror.sessionId,
            { action: "list-files", teamId: mirror.teamId },
            {
              storage: folder,
              listRoot: root,
              ...(descend ? { descend } : {}),
              ...(skipped ? { skipped } : {}),
            },
          )
          .pipe(Effect.result);
        if (listed._tag === "Failure") {
          if (listed.failure.code === "forbidden" || listed.failure.code === "not_found") {
            yield* detachWhere((m) => m.teamId === mirror.teamId, reasons.lostFolder);
            return { kind: "detached" } satisfies Listed;
          }
          yield* note(mirror.teamId, storageProblem(listed.failure));
          return { kind: "unavailable" } satisfies Listed;
        }
        if (listed.success.status !== "connected") {
          yield* note(mirror.teamId, disconnected(listed.success.status));
          return { kind: "unavailable" } satisfies Listed;
        }
        return {
          kind: "files",
          files: listed.success.files.map((file) => ({ path: file.path, etag: file.etag })),
        } satisfies Listed;
      });

    /** A document's text through the copy's session, from the team's checked folder. */
    const readText = (mirror: Mirror, folder: TeamStorage, path: string) =>
      storage
        .execute(
          mirror.sessionId,
          { action: "read-file", teamId: mirror.teamId, path },
          { storage: folder },
        )
        .pipe(Effect.result);

    /**
     * Daily memory files to compare, and the month folders not listed this pass. Reads every
     * member's change markers to choose the older months that changed.
     */
    const listDaily = (mirror: Mirror, folder: TeamStorage) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const seen: DailySeen = daily.get(mirror.teamId) ?? {
          lastFullAt: 0,
          months: new Map(),
          pending: null,
        };
        daily.set(mirror.teamId, seen);
        const depth = (path: string) => path.split("/").length;
        // First the members' folders: their month folders and change markers.
        const monthFolders: string[] = [];
        const top = yield* listFolder(mirror, folder, "Daily", (p) => depth(p) <= 2, monthFolders);
        if (top.kind !== "files") return top;
        const stamps = new Map<string, string>();
        for (const file of top.files) {
          const author = teamDailyMarkerAuthor(file.path);
          if (!author) continue;
          const marker = yield* readText(mirror, folder, file.path);
          // A marker that can't be read can't say what changed: list that member in full.
          const months =
            marker._tag === "Success" && marker.success.document
              ? Option.getOrUndefined(decodeMarker(marker.success.document.text))?.months
              : undefined;
          if (!months) {
            stamps.set(`${author}/*`, "￿");
            continue;
          }
          for (const [month, stamp] of Object.entries(months)) {
            const key = `${author}/${month}`;
            if (stamp > (stamps.get(key) ?? "")) stamps.set(key, stamp);
          }
        }
        const today = localDayAt(nowMs);
        const lastMonth = localDayAt(nowMs - 31 * 24 * 60 * 60_000).slice(0, 7);
        const recent = new Set([today.slice(0, 7), lastMonth]);
        const full = nowMs - seen.lastFullAt >= FULL_DAILY_LISTING_MS;
        const wanted = new Set<string>();
        for (const path of monthFolders) {
          const key = path.slice("Daily/".length);
          const [author, month] = key.split("/");
          const stamp = stamps.get(key);
          if (
            full ||
            recent.has(month ?? "") ||
            stamps.has(`${author}/*`) ||
            (stamp !== undefined && stamp !== seen.months.get(key))
          )
            wanted.add(path);
        }
        const unlisted = monthFolders.filter((path) => !wanted.has(path));
        if (wanted.size === 0) {
          seen.pending = { full, at: nowMs, months: new Map() };
          return { kind: "files", files: [], unlisted } as const;
        }
        const listed = yield* listFolder(
          mirror,
          folder,
          "Daily",
          (p) => depth(p) <= 2 || wanted.has(p),
        );
        if (listed.kind !== "files") return listed;
        seen.pending = {
          full,
          at: nowMs,
          months: new Map(
            [...wanted].map((path) => {
              const key = path.slice("Daily/".length);
              return [key, stamps.get(key) ?? ""] as const;
            }),
          ),
        };
        return {
          kind: "files",
          files: listed.files.filter((file) => isTeamDailyPath(file.path)),
          unlisted,
        } as const;
      });

    /**
     * The teams to copy now: every ready team of the environment's Teams account, unless stopped.
     * Membership answers detach copies; anything that can't be checked keeps them as they are.
     */
    const reconcile = Effect.gen(function* () {
      const current = yield* read;
      const keep = current.filter((mirror) => !mirror.detached && !mirror.off);
      const owner = yield* input.memoryAccount.pipe(Effect.result);
      if (owner._tag === "Failure") return keep;
      if (owner.success === null) {
        yield* detachWhere(() => true, reasons.signedOut);
        return [];
      }
      const { sessionId, identity } = owner.success;
      const status = yield* account.getStatus(sessionId).pipe(Effect.result);
      if (status._tag === "Failure") return keep;
      if (status.success.status !== "signed-in" || !status.success.profile) {
        yield* detachWhere(() => true, reasons.signedOut);
        return [];
      }
      // The session now belongs to someone else: the recorded account's copies go, and nothing is
      // copied for the newcomer until they are made the Teams account here.
      if (identityOf(status.success.profile) !== identity) {
        yield* detachWhere(() => true, reasons.otherAccount);
        return [];
      }
      yield* detachWhere((mirror) => mirror.identity !== identity, reasons.otherAccount);
      const listed = yield* account.teams(sessionId, { action: "list" }).pipe(Effect.result);
      if (listed._tag === "Failure") return keep.filter((mirror) => mirror.identity === identity);
      const teams = listed.success.teams;
      const ready = teams.filter((team) => team.state === "ready");
      const archived = new Set(
        teams.filter((team) => team.state === "archived").map((team) => team.id),
      );
      const member = new Set(teams.map((team) => team.id));
      yield* detachWhere((mirror) => archived.has(mirror.teamId), reasons.archived);
      yield* detachWhere((mirror) => !member.has(mirror.teamId), reasons.lostTeam);
      const since = yield* now;
      const next = yield* update((mirrors) => {
        let changed = false;
        const result = [...mirrors];
        for (const team of ready) {
          const index = result.findIndex((mirror) => mirror.teamId === team.id);
          const existing = index >= 0 ? result[index] : undefined;
          // A stopped copy stays stopped. A copy detached because the account changed or the
          // membership ended starts over once they're back; one whose folder was refused or
          // whose team was archived stays a notice until it is dismissed.
          if (existing && !existing.detached) {
            if (existing.sessionId !== sessionId || existing.teamName !== team.name) {
              result[index] = { ...existing, sessionId, teamName: team.name };
              changed = true;
            }
            continue;
          }
          if (existing?.detached && !RESTARTABLE.has(existing.detached.reason)) continue;
          if (index >= 0) result.splice(index, 1);
          // Detached records are only notices; the oldest make room first.
          while (result.length >= MAX_MIRRORS) {
            const oldest = result.findIndex((mirror) => mirror.detached);
            if (oldest < 0) break;
            result.splice(oldest, 1);
          }
          if (result.length >= MAX_MIRRORS) break;
          const taken = new Set(result.map((mirror) => mirror.folder));
          let folder = existing?.folder ?? mirrorFolder(team.id, team.name);
          for (let attempt = 2; taken.has(folder); attempt++)
            folder = `${mirrorFolder(team.id, team.name)}-${attempt}`;
          result.push({ teamId: team.id, teamName: team.name, folder, sessionId, identity, since });
          changed = true;
        }
        return changed ? result : mirrors;
      });
      return next.filter((mirror) => !mirror.detached && !mirror.off);
    });

    const source: TeamMirrorSource = {
      teams: reconcile.pipe(
        Effect.map((mirrors) => mirrors.map((m) => ({ teamId: m.teamId, folder: m.folder }))),
        // An unreadable record keeps no copies: removal is the safe direction.
        Effect.catch((error) =>
          Effect.logWarning("local team copies unreadable", { error }).pipe(Effect.as([])),
        ),
      ),
      list: (teamId) =>
        Effect.gen(function* () {
          const mirror = yield* active(teamId);
          if (!mirror) return { kind: "detached" } satisfies TeamMirrorListing;
          const access = yield* checkAccess(mirror);
          if (access === "detached" || access === "unavailable") return { kind: access } as const;
          const files: { path: string; eTag: string }[] = [];
          for (const root of ROOTS) {
            const listed = yield* listFolder(mirror, access, root);
            if (listed.kind !== "files") return listed;
            for (const file of listed.files)
              if (file.path.startsWith(`${root}/`) && isTeamDocumentPath(file.path))
                files.push({ path: file.path, eTag: file.etag });
          }
          const dailyListing = yield* listDaily(mirror, access);
          if (dailyListing.kind !== "files") return dailyListing;
          for (const file of dailyListing.files) files.push({ path: file.path, eTag: file.etag });
          return { kind: "files", files, unlisted: dailyListing.unlisted } as const;
        }).pipe(
          Effect.catch((error) =>
            note(teamId, error.message).pipe(Effect.as({ kind: "unavailable" } as const)),
          ),
        ),
      read: (teamId, path) =>
        Effect.gen(function* () {
          const mirror = yield* active(teamId);
          if (!mirror) return { kind: "detached" } as const;
          const copied =
            (ROOTS.some((root) => path.startsWith(`${root}/`)) && isTeamDocumentPath(path)) ||
            isTeamDailyPath(path);
          if (!copied) return { kind: "skip" } as const;
          const session = yield* checkSession(mirror);
          if (session !== "current") return { kind: session } as const;
          const folder = roots.get(teamId);
          if (!folder) return { kind: "unavailable" } as const;
          const result = yield* readText(mirror, folder, path);
          if (result._tag === "Failure") {
            if (result.failure.code === "sign_in_required") {
              yield* note(teamId, storageProblem(result.failure));
              return { kind: "unavailable" } as const;
            }
            // Removed, too large, or changed while it was read: the next pass looks again.
            return { kind: "skip" } as const;
          }
          const document = result.success.document;
          if (!document) {
            yield* note(teamId, disconnected(result.success.status));
            return { kind: "unavailable" } as const;
          }
          return { kind: "file", text: document.text, eTag: document.etag } as const;
        }).pipe(
          Effect.catch((error) =>
            note(teamId, error.message).pipe(Effect.as({ kind: "unavailable" } as const)),
          ),
        ),
      report: (teamId, outcome: TeamMirrorOutcome) =>
        Effect.sync(() => {
          const seen = daily.get(teamId);
          if (outcome.kind === "failed") {
            if (seen) seen.pending = null;
            progress.set(teamId, {
              lastSyncedAt: progress.get(teamId)?.lastSyncedAt ?? null,
              message: outcome.message,
            });
            return;
          }
          // Months count as seen only once the copy holds every file listed in them.
          if (seen?.pending && outcome.pending === 0) {
            for (const [key, stamp] of seen.pending.months) seen.months.set(key, stamp);
            if (seen.pending.full) seen.lastFullAt = seen.pending.at;
          }
          if (seen) seen.pending = null;
          const plural = (count: number) => (count === 1 ? "document" : "documents");
          progress.set(teamId, {
            lastSyncedAt: outcome.at,
            message:
              outcome.pending > 0
                ? `${outcome.pending} more ${plural(outcome.pending)} will be copied over the next few syncs.`
                : outcome.skipped > 0
                  ? `${outcome.skipped} ${plural(outcome.skipped)} couldn't be copied this time.`
                  : null,
          });
        }),
    };
    yield* host.attach(source);

    const listFor = (identity: string) =>
      read.pipe(
        Effect.map((mirrors) =>
          mirrors.filter((mirror) => mirror.identity === identity).map(toContract),
        ),
      );

    return {
      /** The caller's copies: kept, stopped, and detached. */
      list: (profile: { issuer: string; subject: string }) =>
        reconcile.pipe(Effect.ignore, Effect.andThen(listFor(identityOf(profile)))),
      /** Keeps a stopped copy of a team the caller belongs to again. */
      enable: (profile: { issuer: string; subject: string }, teamId: string) =>
        Effect.gen(function* () {
          const identity = identityOf(profile);
          yield* update((mirrors) =>
            mirrors.some((m) => m.teamId === teamId && m.identity === identity && m.off)
              ? mirrors.map((m) => {
                  if (m.teamId !== teamId || m.identity !== identity) return m;
                  const { off: _off, ...kept } = m;
                  return kept;
                })
              : mirrors,
          );
          yield* forget(teamId);
          yield* host.sync.pipe(Effect.forkDetach);
          return yield* listFor(identity);
        }),
      /** Stops the caller's copy of a team and removes it, or dismisses a detached record. */
      disable: (profile: { issuer: string; subject: string }, teamId: string) =>
        Effect.gen(function* () {
          const identity = identityOf(profile);
          yield* update((mirrors) =>
            mirrors.flatMap((mirror) => {
              if (mirror.teamId !== teamId || mirror.identity !== identity) return [mirror];
              return mirror.detached ? [] : [{ ...mirror, off: true as const }];
            }),
          );
          yield* forget(teamId);
          yield* host.prune;
          return yield* listFor(identity);
        }),
      /** Detaches every copy read through a session that signed out, and removes them now. */
      signedOut: (sessionId: string) =>
        detachWhere((mirror) => mirror.sessionId === sessionId, reasons.signedOut).pipe(
          Effect.andThen(host.prune),
        ),
    };
  });

export type TeamMemoryMirrors = Effect.Success<ReturnType<typeof makeTeamMemoryMirror>>;
