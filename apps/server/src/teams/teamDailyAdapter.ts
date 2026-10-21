/**
 * The Teams side of daily team memory (see `memory/teamDailySource.ts`): who the author is, which
 * teams they can write to, which projects here are linked to each, and every write.
 *
 * The author is the environment's Teams account: the campus session that last used Teams here.
 * A team is lost only on a definite answer (not a member, archived, or the folder refused); an
 * answer that can't be had holds the team. Every write checks the account, the membership, the
 * links its new text came from, and that every thread in it is still shared, and the last of
 * those checks runs inside the storage request path right before each request that changes the
 * file.
 */
import { type TeamStorage, TeamsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AccountService } from "../auth/AccountService.ts";
import type {
  TeamDailyAccount,
  TeamDailyInspection,
  TeamDailySource,
  TeamDailyWorkspace,
  TeamDailyWrite,
} from "../memory/teamDailySource.ts";
import { teamDailyMarkerAuthor } from "../memory/teamDaily.ts";
import { identityOf, type TeamMemoryAccount } from "./teamMemoryMirror.ts";
import type { TeamStorageService } from "./TeamStorageService.ts";

export interface TeamDailyLink {
  readonly projectId: string;
  readonly teamId: string;
  readonly storage: TeamStorage;
  /** When the link began sharing work. */
  readonly sharingSince: string;
}

const sameStorage = (a: TeamStorage, b: TeamStorage) =>
  a.tenantId.toLowerCase() === b.tenantId.toLowerCase() &&
  a.siteId === b.siteId &&
  a.driveId === b.driveId &&
  a.folderId === b.folderId;

const changed = (message: string) => new TeamsError({ code: "conflict", message });

/** A team folder as an opaque key; a daily file is only ever updated in the folder it went to. */
const storageKeyOf = (folder: TeamStorage) =>
  [folder.tenantId.toLowerCase(), folder.siteId, folder.driveId, folder.folderId].join("|");

export const makeTeamDailySource = (input: {
  readonly account: AccountService["Service"];
  readonly storage: TeamStorageService["Service"];
  readonly memoryAccount: Effect.Effect<TeamMemoryAccount | null, TeamsError>;
  /** This environment's links whose projects still exist, each with when it began sharing. */
  readonly links: Effect.Effect<ReadonlyArray<TeamDailyLink>, TeamsError>;
}): TeamDailySource => {
  const { account, storage } = input;
  const unavailable = (message: string) =>
    ({ kind: "unavailable", message }) satisfies TeamDailyAccount;

  /**
   * The Teams account's session and profile now, or why there is none. A session that now
   * belongs to someone else shares nothing until that person is made the Teams account here.
   */
  const signedIn = Effect.gen(function* () {
    const owner = yield* input.memoryAccount.pipe(Effect.result);
    if (owner._tag === "Failure") return unavailable(owner.failure.message);
    if (!owner.success) return { kind: "signed-out" } as const;
    const status = yield* account.getStatus(owner.success.sessionId).pipe(Effect.result);
    if (status._tag === "Failure")
      return unavailable("Your UC San Diego account couldn't be checked. Harness will try again.");
    const profile = status.success.profile;
    if (status.success.status !== "signed-in" || !profile) return { kind: "signed-out" } as const;
    if (identityOf(profile) !== owner.success.identity) return { kind: "signed-out" } as const;
    return {
      kind: "current",
      sessionId: owner.success.sessionId,
      profile,
      since: owner.success.since ?? null,
    } as const;
  });
  /** Sharing starts with the link, but never before this account became the Teams account. */
  const sinceOf = (link: TeamDailyLink, accountSince: string | null) =>
    accountSince !== null && accountSince > link.sharingSince ? accountSince : link.sharingSince;
  /** The team's current folder, after checking it is still a team the account can write to. */
  const teamFolder = (sessionId: string, teamId: string) =>
    account.teams(sessionId, { action: "get", teamId }).pipe(
      Effect.map((detail) => {
        const team = detail.team;
        if (!team || team.id !== teamId || team.state === "archived")
          return { kind: "lost" } as const;
        if (team.state !== "ready" || !team.storage)
          return { kind: "held", message: "The team's folder is being checked." } as const;
        return { kind: "ready", folder: team.storage } as const;
      }),
      Effect.catch((error: TeamsError) =>
        Effect.succeed(
          error.code === "not_found" || error.code === "forbidden"
            ? ({ kind: "lost" } as const)
            : ({ kind: "held", message: error.message } as const),
        ),
      ),
    );

  const accountFor: TeamDailySource["account"] = (known) =>
    Effect.gen(function* () {
      const session = yield* signedIn;
      if (session.kind !== "current") return session;
      const listed = yield* account
        .teams(session.sessionId, { action: "list" })
        .pipe(Effect.result);
      if (listed._tag === "Failure") return unavailable(listed.failure.message);
      const links = yield* input.links.pipe(Effect.result);
      if (links._tag === "Failure") return unavailable(links.failure.message);
      const teamIds = [...new Set([...links.success.map((link) => link.teamId), ...known])];
      const workspaces: TeamDailyWorkspace[] = [];
      for (const teamId of teamIds) {
        const summary = listed.success.teams.find((team) => team.id === teamId);
        const base = { teamId, teamName: summary?.name ?? "", projects: [], storageKey: null };
        if (!summary || summary.state === "archived") {
          workspaces.push({ ...base, access: "lost" });
          continue;
        }
        if (summary.state !== "ready") {
          workspaces.push({
            ...base,
            access: "held",
            message: "The team's folder is being checked.",
          });
          continue;
        }
        if (summary.role === "reader") {
          workspaces.push({
            ...base,
            access: "held",
            message: "You have read-only access to this team, so your work isn't shared with it.",
          });
          continue;
        }
        const folder = yield* teamFolder(session.sessionId, teamId);
        if (folder.kind !== "ready") {
          workspaces.push(
            folder.kind === "lost"
              ? { ...base, access: "lost" }
              : { ...base, access: "held", message: folder.message },
          );
          continue;
        }
        // Links pin the folder they were made for; one that no longer matches shares nothing.
        workspaces.push({
          ...base,
          access: "ready",
          storageKey: storageKeyOf(folder.folder),
          projects: links.success
            .filter((link) => link.teamId === teamId && sameStorage(link.storage, folder.folder))
            .map((link) => ({
              projectId: link.projectId,
              sharingSince: sinceOf(link, session.since),
            })),
        });
      }
      return {
        kind: "signed-in",
        author: identityOf(session.profile),
        authorName: session.profile.displayName || session.profile.email,
        workspaces,
      } satisfies TeamDailyAccount;
    });

  /** The session to act as, after checking the author, the team, and the folder. */
  const acting = (request: {
    readonly teamId: string;
    readonly author: string;
    readonly storageKey: string | null;
  }) =>
    Effect.gen(function* () {
      const session = yield* signedIn;
      if (session.kind === "unavailable")
        return { kind: "held", message: session.message } as const;
      if (session.kind === "signed-out")
        return { kind: "held", message: "Sign in with UC San Diego to share your work." } as const;
      // Files are only ever written as their own author.
      if (identityOf(session.profile) !== request.author)
        return { kind: "held", message: "A different UC San Diego account is signed in." } as const;
      const folder = yield* teamFolder(session.sessionId, request.teamId);
      if (folder.kind !== "ready") return folder;
      // Never redirected to another folder: an earlier file stays where it was published.
      if (request.storageKey !== null && request.storageKey !== storageKeyOf(folder.folder))
        return {
          kind: "rejected",
          message:
            "The team's folder changed, so Harness can't update this day's shared memory in the folder it was published to.",
        } as const;
      return { kind: "ready", session, folder: folder.folder } as const;
    });

  const write: TeamDailySource["write"] = (request) =>
    Effect.gen(function* () {
      const held = (message: string): TeamDailyWrite => ({ kind: "held", message });
      const ready = yield* acting(request);
      if (ready.kind !== "ready") return ready;
      const { session, folder } = ready;
      /** The links the file's new text came from still hold, with the same folder. */
      const linksHold = input.links.pipe(
        Effect.map((links) =>
          request.freshProjects.every((fresh) =>
            links.some(
              (link) =>
                link.projectId === fresh.projectId &&
                link.teamId === request.teamId &&
                sinceOf(link, session.since) === fresh.sharingSince &&
                sameStorage(link.storage, folder),
            ),
          ),
        ),
      );
      if (!(yield* linksHold)) return held("A project's team link changed.");
      // Runs again inside the storage request path, after any token refresh, right before each
      // request that changes the file.
      const guard = Effect.gen(function* () {
        const owner = yield* input.memoryAccount.pipe(
          Effect.mapError(() => changed("The Teams account couldn't be checked.")),
        );
        const now = yield* account
          .getStatus(session.sessionId)
          .pipe(Effect.mapError(() => changed("Your UC San Diego account couldn't be checked.")));
        if (
          owner?.sessionId !== session.sessionId ||
          owner.identity !== request.author ||
          now.status !== "signed-in" ||
          !now.profile ||
          identityOf(now.profile) !== request.author
        )
          return yield* changed("A different UC San Diego account is signed in.");
        if (!(yield* request.stillShared))
          return yield* changed("A thread's team sharing changed.");
        if (!(yield* linksHold)) return yield* changed("A project's team link changed.");
      });
      const result = yield* storage
        .writeDaily(
          session.sessionId,
          {
            action: "daily-write",
            teamId: request.teamId,
            path: request.path,
            text: request.text,
            etag: request.etag,
            guard,
            // A change marker holds no memory, so a stale one is simply replaced.
            replaceChanged: teamDailyMarkerAuthor(request.path) !== null,
          },
          { storage: folder },
        )
        .pipe(Effect.result);
      if (result._tag === "Success")
        return {
          kind: "written",
          etag: result.success,
          storageKey: storageKeyOf(folder),
        } satisfies TeamDailyWrite;
      // Too large is the one answer that can't change by trying again; nothing was sent.
      if (result.failure.code === "invalid_request")
        return { kind: "rejected", message: result.failure.message } satisfies TeamDailyWrite;
      // The file isn't the version last written; nothing was sent.
      if (result.failure.code === "conflict" && result.failure.message.includes("SharePoint"))
        return { kind: "changed", message: result.failure.message } satisfies TeamDailyWrite;
      // Membership was just confirmed: a failed write is held, never taken as access ending.
      return held(result.failure.message);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<TeamDailyWrite>({ kind: "held", message: error.message }),
      ),
    );

  const inspect: TeamDailySource["inspect"] = (request) =>
    Effect.gen(function* () {
      const ready = yield* acting(request);
      if (ready.kind === "lost") return ready;
      if (ready.kind !== "ready")
        return { kind: "held", message: ready.message } satisfies TeamDailyInspection;
      const read = yield* storage
        .execute(
          ready.session.sessionId,
          { action: "read-file", teamId: request.teamId, path: request.path },
          { storage: ready.folder },
        )
        .pipe(Effect.result);
      if (read._tag === "Failure")
        return read.failure.code === "not_found"
          ? ({ kind: "missing" } satisfies TeamDailyInspection)
          : ({ kind: "held", message: read.failure.message } satisfies TeamDailyInspection);
      const document = read.success.document;
      if (!document)
        return {
          kind: "held",
          message: "Connect Microsoft in Teams to share your work.",
        } satisfies TeamDailyInspection;
      return {
        kind: "file",
        text: document.text,
        etag: document.etag,
      } satisfies TeamDailyInspection;
    });

  return { account: accountFor, write, inspect };
};
