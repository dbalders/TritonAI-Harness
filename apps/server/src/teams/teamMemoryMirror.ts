/**
 * Local copies of team memory: which teams this environment copies into the memory vault, and
 * the access checks MemorySync's passes make before copying anything (see `teamMirror.ts`).
 *
 * A copy is made for one campus identity through the app session that turned it on, from the
 * folder a project link here pins. It holds only memory notes and SOPs; skills reach agents only
 * through the per-project approval in Settings → Skills. The first pass after access ends (sign-out,
 * another account, removal from the team, the team archived, Graph refusing the folder, the folder
 * changing, or the last project link going) removes the copy and keeps a detached record so the Teams page can say why.
 */
import {
  type AccountStatus,
  type TeamMemoryMirror,
  type TeamStorage,
  TeamsError,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { AccountService } from "../auth/AccountService.ts";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import type {
  TeamMirrorHost,
  TeamMirrorListing,
  TeamMirrorOutcome,
  TeamMirrorSource,
} from "../memory/sync/teamMirror.ts";
import { isTeamDocumentPath } from "./teamDocuments.ts";
import type { TeamStorageService } from "./TeamStorageService.ts";

const SECRET_NAME = "team-memory-mirrors";
const MAX_MIRRORS = 100;
/** The folders copied. Skills stay out: an agent gets one only after per-project approval. */
const ROOTS = ["Memory", "SOPs"] as const;
const Mirror = Schema.Struct({
  teamId: Schema.String,
  teamName: Schema.String,
  folder: Schema.String,
  /** The app session whose campus and Microsoft sign-in the copy is read with. */
  sessionId: Schema.String,
  /** sha256 of `[issuer, subject]`, as the membership service names author folders. */
  identity: Schema.String,
  since: Schema.String,
  detached: Schema.optionalKey(Schema.Struct({ reason: Schema.String, at: Schema.String })),
});
type Mirror = typeof Mirror.Type;
const Mirrors = Schema.fromJsonString(Schema.Array(Mirror).check(Schema.isMaxLength(MAX_MIRRORS)));
const decodeMirrors = Schema.decodeUnknownEffect(Mirrors);
const encodeMirrors = Schema.encodeEffect(Mirrors);
const sameStorage = (a: TeamStorage, b: TeamStorage) =>
  a.tenantId.toLowerCase() === b.tenantId.toLowerCase() &&
  a.siteId === b.siteId &&
  a.driveId === b.driveId &&
  a.folderId === b.folderId;

export const identityOf = (profile: { issuer: string; subject: string }) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([profile.issuer, profile.subject]))
    .digest("base64url");

/** A readable folder name that stays with the copy when the team is renamed. */
export const mirrorFolder = (teamId: string, teamName: string) => {
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
  movedFolder:
    "The team's folder changed, so the local copy was removed. Link a project again to keep a new copy.",
  unlinked:
    "No project in this environment is linked to the team anymore, so the local copy was removed.",
} as const;

export interface TeamProjectLinkRecord {
  readonly teamId: string;
  readonly storage: TeamStorage;
}

export const makeTeamMemoryMirror = (input: {
  readonly account: AccountService["Service"];
  readonly storage: TeamStorageService["Service"];
  readonly secrets: ServerSecretStore["Service"];
  readonly host: TeamMirrorHost["Service"];
  /** The environment's project links, read fresh each time. */
  readonly links: Effect.Effect<ReadonlyArray<TeamProjectLinkRecord>, TeamsError>;
}) =>
  Effect.gen(function* () {
    const { account, storage, secrets, host } = input;
    const lock = yield* Semaphore.make(1);
    /** Sync progress by team, kept for this server's life. */
    const progress = new Map<string, { lastSyncedAt: string | null; message: string | null }>();

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
    /** Marks matching copies detached; the next pass or prune removes their folders. */
    const detachWhere = (matches: (mirror: Mirror) => boolean, reason: string) =>
      Effect.gen(function* () {
        const at = yield* now;
        yield* update((mirrors) =>
          mirrors.some((mirror) => !mirror.detached && matches(mirror))
            ? mirrors.map((mirror) =>
                !mirror.detached && matches(mirror)
                  ? { ...mirror, detached: { reason, at } }
                  : mirror,
              )
            : mirrors,
        );
      });
    const active = (teamId: string) =>
      read.pipe(Effect.map((mirrors) => mirrors.find((m) => m.teamId === teamId && !m.detached)));

    const toContract = (mirror: Mirror): TeamMemoryMirror => {
      const state = progress.get(mirror.teamId);
      return {
        teamId: mirror.teamId,
        teamName: mirror.teamName,
        folder: `teams/${mirror.folder}`,
        state: mirror.detached ? "detached" : "mirrored",
        lastSyncedAt: mirror.detached ? null : (state?.lastSyncedAt ?? null),
        message: mirror.detached?.reason ?? state?.message ?? null,
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

    /** The link's pinned folder for a team, after membership and the session are checked. */
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
        const links = yield* input.links.pipe(Effect.result);
        if (links._tag === "Failure") {
          yield* note(mirror.teamId, links.failure.message);
          return "unavailable" as const;
        }
        const link = links.success.find((entry) => entry.teamId === mirror.teamId);
        if (!link) return yield* detach(reasons.unlinked);
        if (!sameStorage(link.storage, team.storage)) return yield* detach(reasons.movedFolder);
        return link.storage;
      });

    const storageProblem = (error: TeamsError) =>
      error.code === "sign_in_required"
        ? "Reconnect Microsoft in Teams → your team → Shared storage to keep this copy up to date."
        : error.message;
    const disconnected = (status: string) =>
      status === "not-configured"
        ? "Microsoft storage is not set up for this environment yet."
        : "Connect Microsoft in Teams → your team → Shared storage to keep this copy up to date.";

    const source: TeamMirrorSource = {
      teams: Effect.gen(function* () {
        const links = yield* input.links.pipe(Effect.orElseSucceed(() => null));
        // Without links nothing can be decided; keep every copy until they can be read.
        if (links) {
          const linked = new Set(links.map((link) => link.teamId));
          yield* detachWhere((mirror) => !linked.has(mirror.teamId), reasons.unlinked);
        }
        return (yield* read)
          .filter((mirror) => !mirror.detached)
          .map((mirror) => ({ teamId: mirror.teamId, folder: mirror.folder }));
      }).pipe(
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
            const listed = yield* storage
              .execute(
                mirror.sessionId,
                { action: "list-files", teamId },
                { storage: access, listRoot: root },
              )
              .pipe(Effect.result);
            if (listed._tag === "Failure") {
              if (listed.failure.code === "forbidden" || listed.failure.code === "not_found") {
                yield* detachWhere((m) => m.teamId === teamId, reasons.lostFolder);
                return { kind: "detached" } as const;
              }
              yield* note(teamId, storageProblem(listed.failure));
              return { kind: "unavailable" } as const;
            }
            if (listed.success.status !== "connected") {
              yield* note(teamId, disconnected(listed.success.status));
              return { kind: "unavailable" } as const;
            }
            for (const file of listed.success.files)
              if (file.path.startsWith(`${root}/`) && isTeamDocumentPath(file.path))
                files.push({ path: file.path, eTag: file.etag });
          }
          return { kind: "files", files } as const;
        }).pipe(
          Effect.catch((error) =>
            note(teamId, error.message).pipe(Effect.as({ kind: "unavailable" } as const)),
          ),
        ),
      read: (teamId, path) =>
        Effect.gen(function* () {
          const mirror = yield* active(teamId);
          if (!mirror) return { kind: "detached" } as const;
          if (!ROOTS.some((root) => path.startsWith(`${root}/`)) || !isTeamDocumentPath(path))
            return { kind: "skip" } as const;
          const session = yield* checkSession(mirror);
          if (session !== "current") return { kind: session } as const;
          const link = (yield* input.links).find((entry) => entry.teamId === teamId);
          if (!link) {
            yield* detachWhere((m) => m.teamId === teamId, reasons.unlinked);
            return { kind: "detached" } as const;
          }
          const result = yield* storage
            .execute(
              mirror.sessionId,
              { action: "read-file", teamId, path },
              { storage: link.storage },
            )
            .pipe(Effect.result);
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
          if (outcome.kind === "failed") {
            progress.set(teamId, {
              lastSyncedAt: progress.get(teamId)?.lastSyncedAt ?? null,
              message: outcome.message,
            });
            return;
          }
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
      /** The caller's copies, mirrored and detached. */
      list: (profile: { issuer: string; subject: string }) => listFor(identityOf(profile)),
      /**
       * Starts or resumes a copy for the caller. The caller has checked membership and that a link
       * here pins the team's current folder. The first copy starts in the background.
       */
      enable: (
        sessionId: string,
        profile: { issuer: string; subject: string },
        team: { id: string; name: string },
      ) =>
        Effect.gen(function* () {
          const identity = identityOf(profile);
          const since = yield* now;
          yield* update((mirrors) => {
            const existing = mirrors.find((mirror) => mirror.teamId === team.id);
            const others = mirrors.filter((mirror) => mirror.teamId !== team.id);
            // Detached records are only notices; the oldest make room first.
            while (others.length >= MAX_MIRRORS) {
              const oldest = others.findIndex((mirror) => mirror.detached);
              if (oldest < 0) break;
              others.splice(oldest, 1);
            }
            const taken = new Set(others.map((mirror) => mirror.folder));
            let folder = existing?.folder ?? mirrorFolder(team.id, team.name);
            for (let attempt = 2; taken.has(folder); attempt++)
              folder = `${mirrorFolder(team.id, team.name)}-${attempt}`;
            const next: Mirror = {
              teamId: team.id,
              teamName: team.name,
              folder,
              sessionId,
              identity,
              since: existing && !existing.detached ? existing.since : since,
            };
            return [...others, next];
          });
          progress.delete(team.id);
          yield* host.sync.pipe(Effect.forkDetach);
          return yield* listFor(identity);
        }),
      /** Stops the caller's copy of a team and removes it, or dismisses a detached record. */
      disable: (profile: { issuer: string; subject: string }, teamId: string) =>
        Effect.gen(function* () {
          const identity = identityOf(profile);
          yield* update((mirrors) =>
            mirrors.some((mirror) => mirror.teamId === teamId && mirror.identity === identity)
              ? mirrors.filter((mirror) => mirror.teamId !== teamId)
              : mirrors,
          );
          progress.delete(teamId);
          yield* host.prune;
          return yield* listFor(identity);
        }),
      /** Detaches every copy read through a session that signed out, and removes them now. */
      signedOut: (sessionId: string) =>
        detachWhere((mirror) => mirror.sessionId === sessionId, reasons.signedOut).pipe(
          Effect.andThen(host.prune),
        ),
      /** Removes copies whose team lost its last link here. */
      linksChanged: host.prune,
    };
  });

export type TeamMemoryMirrors = Effect.Success<ReturnType<typeof makeTeamMemoryMirror>>;
