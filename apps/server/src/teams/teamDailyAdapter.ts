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
  TeamDailySource,
  TeamDailyWorkspace,
  TeamDailyWrite,
} from "../memory/teamDailySource.ts";
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

  /** The Teams account's session and profile now, or why there is none. */
  const signedIn = Effect.gen(function* () {
    const owner = yield* input.memoryAccount.pipe(Effect.result);
    if (owner._tag === "Failure") return unavailable(owner.failure.message);
    if (!owner.success) return { kind: "signed-out" } as const;
    const status = yield* account.getStatus(owner.success.sessionId).pipe(Effect.result);
    if (status._tag === "Failure")
      return unavailable("Your UC San Diego account couldn't be checked. Harness will try again.");
    const profile = status.success.profile;
    if (status.success.status !== "signed-in" || !profile) return { kind: "signed-out" } as const;
    return { kind: "current", sessionId: owner.success.sessionId, profile } as const;
  });

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
        const base = { teamId, teamName: summary?.name ?? "", projects: [] };
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
        const teamLinks = links.success.filter((link) => link.teamId === teamId);
        if (teamLinks.length === 0) {
          workspaces.push({ ...base, access: "ready" });
          continue;
        }
        // Links pin the folder they were made for; one that no longer matches shares nothing.
        const detail = yield* account
          .teams(session.sessionId, { action: "get", teamId })
          .pipe(Effect.result);
        if (detail._tag === "Failure") {
          const lost = detail.failure.code === "not_found" || detail.failure.code === "forbidden";
          workspaces.push(
            lost
              ? { ...base, access: "lost" }
              : { ...base, access: "held", message: detail.failure.message },
          );
          continue;
        }
        const folder = detail.success.team?.storage;
        workspaces.push({
          ...base,
          access: "ready",
          projects: folder
            ? teamLinks
                .filter((link) => sameStorage(link.storage, folder))
                .map((link) => ({ projectId: link.projectId, sharingSince: link.sharingSince }))
            : [],
        });
      }
      return {
        kind: "signed-in",
        author: identityOf(session.profile),
        authorName: session.profile.displayName || session.profile.email,
        workspaces,
      } satisfies TeamDailyAccount;
    });

  const write: TeamDailySource["write"] = (request) =>
    Effect.gen(function* () {
      const held = (message: string): TeamDailyWrite => ({ kind: "held", message });
      const session = yield* signedIn;
      if (session.kind === "unavailable") return held(session.message);
      if (session.kind === "signed-out")
        return held("Sign in with UC San Diego to share your work.");
      // Files are only ever written as their own author.
      if (identityOf(session.profile) !== request.author)
        return held("A different UC San Diego account is signed in.");
      const detail = yield* account
        .teams(session.sessionId, { action: "get", teamId: request.teamId })
        .pipe(Effect.result);
      if (detail._tag === "Failure")
        return detail.failure.code === "not_found" || detail.failure.code === "forbidden"
          ? ({ kind: "lost" } satisfies TeamDailyWrite)
          : held(detail.failure.message);
      const team = detail.success.team;
      if (!team || team.id !== request.teamId || team.state === "archived")
        return { kind: "lost" } satisfies TeamDailyWrite;
      if (team.state !== "ready" || !team.storage)
        return held("The team's folder is being checked.");
      const folder = team.storage;
      /** The links the file's new text came from still hold, with the same folder. */
      const linksHold = input.links.pipe(
        Effect.map((links) =>
          request.freshProjects.every((fresh) =>
            links.some(
              (link) =>
                link.projectId === fresh.projectId &&
                link.teamId === request.teamId &&
                link.sharingSince === fresh.sharingSince &&
                sameStorage(link.storage, folder),
            ),
          ),
        ),
      );
      if (!(yield* linksHold)) return held("A project's team link changed.");
      // Runs again inside the storage request path, after any token refresh, right before each
      // request that changes the file.
      const guard = Effect.gen(function* () {
        const now = yield* account
          .getStatus(session.sessionId)
          .pipe(Effect.mapError(() => changed("Your UC San Diego account couldn't be checked.")));
        if (
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
          },
          { storage: folder },
        )
        .pipe(Effect.result);
      if (result._tag === "Success")
        return { kind: "written", etag: result.success } satisfies TeamDailyWrite;
      // Membership was just confirmed: a failed write is held, never taken as access ending.
      return held(result.failure.message);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<TeamDailyWrite>({ kind: "held", message: error.message }),
      ),
    );

  return { account: accountFor, write };
};
