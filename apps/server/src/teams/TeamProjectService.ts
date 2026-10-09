import {
  type ProjectId,
  type ThreadId,
  type TeamProjectCommand,
  type TeamProjectLink,
  type TeamProjectResult,
  TeamStorage,
  TeamsError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AccountService } from "../auth/AccountService.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TeamStorageService } from "./TeamStorageService.ts";

const MAX_LINKS = 500;
const SECRET_NAME = "team-project-links";
const Link = Schema.Struct({
  projectId: Schema.String,
  teamId: Schema.String,
  storage: TeamStorage,
  linkedAt: Schema.String,
});
type Link = typeof Link.Type;
const Links = Schema.fromJsonString(Schema.Array(Link).check(Schema.isMaxLength(MAX_LINKS)));
const sameLink = (a: Link, b: Link | undefined) =>
  b !== undefined &&
  a.teamId === b.teamId &&
  a.linkedAt === b.linkedAt &&
  a.storage.tenantId === b.storage.tenantId &&
  a.storage.siteId === b.storage.siteId &&
  a.storage.driveId === b.storage.driveId &&
  a.storage.folderId === b.storage.folderId;
const decodeLinks = Schema.decodeUnknownEffect(Links);
const encodeLinks = Schema.encodeEffect(Links);
const failure = (message: string) => new TeamsError({ code: "unavailable", message });
const notLinked = () =>
  new TeamsError({
    code: "not_found",
    message: "This project is not linked to a team you can open. Link it from Teams.",
  });

/**
 * Links a local Harness project to one team's shared memory. The link is local metadata, not a
 * filesystem boundary: every memory call reresolves the team from this server-side record and
 * rechecks the caller's campus identity, membership, role, and the exact storage root.
 * Team content is never written into the project workspace, personal memory, or provider state.
 */
export class TeamProjectService extends Context.Service<
  TeamProjectService,
  {
    readonly execute: (
      sessionId: string,
      command: TeamProjectCommand,
    ) => Effect.Effect<TeamProjectResult, TeamsError>;
  }
>()("t3/teams/TeamProjectService") {}

export const make = Effect.gen(function* () {
  const account = yield* AccountService;
  const storage = yield* TeamStorageService;
  const secrets = yield* ServerSecretStore;
  const projects = yield* ProjectionSnapshotQuery;
  const lock = yield* Semaphore.make(1);

  const readLinks = secrets.get(SECRET_NAME).pipe(
    Effect.flatMap((value) =>
      Option.isSome(value)
        ? decodeLinks(new TextDecoder().decode(value.value))
        : Effect.succeed([] as readonly Link[]),
    ),
    Effect.mapError(() => failure("Team project links could not be read securely.")),
  );
  const writeLinks = (links: readonly Link[]) =>
    encodeLinks(links).pipe(
      Effect.flatMap((encoded) => secrets.set(SECRET_NAME, new TextEncoder().encode(encoded))),
      Effect.mapError(() => failure("Team project links could not be saved securely.")),
    );
  const activeProject = (projectId: ProjectId) =>
    projects.getProjectShellById(projectId).pipe(
      Effect.mapError(() => failure("Harness projects could not be read.")),
      Effect.map(Option.getOrNull),
    );
  /** Membership for the exact requested team; non-members get the same answer as unknown teams. */
  const readyTeam = (sessionId: string, teamId: string) =>
    Effect.gen(function* () {
      const team = (yield* account.teams(sessionId, { action: "get", teamId })).team;
      if (!team || team.id !== teamId)
        return yield* new TeamsError({
          code: "not_found",
          message: "This team is not available to your account.",
        });
      if (team.state !== "ready" || !team.storage)
        return yield* failure("The team's private folder is not ready.");
      return { ...team, storage: team.storage };
    });
  const listFor = (team: { id: string; name: string }, links: readonly Link[]) =>
    Effect.gen(function* () {
      const result: TeamProjectLink[] = [];
      for (const link of links) {
        if (link.teamId !== team.id) continue;
        const project = yield* activeProject(link.projectId as ProjectId);
        if (project)
          result.push({
            projectId: project.id,
            projectTitle: project.title,
            teamId: link.teamId,
            teamName: team.name,
            linkedAt: link.linkedAt,
          });
      }
      return result;
    });

  const share = Effect.fn("TeamProjectService.share")(function* (
    sessionId: string,
    command: Extract<TeamProjectCommand, { action: "share" }>,
  ) {
    const thread = yield* projects.getThreadShellById(command.threadId as ThreadId).pipe(
      Effect.mapError(() => failure("The thread could not be read.")),
      Effect.map(Option.getOrNull),
    );
    const project = thread ? yield* activeProject(thread.projectId) : null;
    if (!thread || !project)
      return yield* new TeamsError({
        code: "not_found",
        message: "This thread no longer exists.",
      });
    // A project linked to this team keeps using the root it was linked to.
    const link = (yield* readLinks).find(
      (entry) => entry.projectId === project.id && entry.teamId === command.teamId,
    );
    const status = yield* storage.execute(
      sessionId,
      {
        action: "publish",
        teamId: command.teamId,
        kind: "memory",
        recordId: command.recordId,
        deviceId: command.deviceId,
        title: command.title,
        project: project.title.slice(0, 80),
        text: command.text,
      },
      link ? { storage: link.storage } : undefined,
    );
    return { projects: [], storage: status };
  });

  const execute = Effect.fn("TeamProjectService.execute")(function* (
    sessionId: string,
    command: TeamProjectCommand,
  ) {
    if (command.action === "list") {
      const team = yield* readyTeam(sessionId, command.teamId);
      return { projects: yield* listFor(team, yield* readLinks), storage: null };
    }
    if (command.action === "share") return yield* share(sessionId, command);
    if (command.action === "bind" || command.action === "unbind") {
      const team = yield* readyTeam(sessionId, command.teamId);
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const links = yield* readLinks;
          const existing = links.find((link) => link.projectId === command.projectId);
          if (command.action === "unbind") {
            // Unlinking only ever reduces access, but it must name the team it was linked to.
            if (existing && existing.teamId !== team.id) return yield* notLinked();
            const next = links.filter((link) => link.projectId !== command.projectId);
            if (existing) yield* writeLinks(next);
            return { projects: yield* listFor(team, next), storage: null };
          }
          if (!(yield* activeProject(command.projectId)))
            return yield* new TeamsError({
              code: "not_found",
              message: "This Harness project no longer exists.",
            });
          // A link never moves between teams; relinking requires an explicit unlink first.
          if (existing && existing.teamId !== team.id)
            return yield* new TeamsError({
              code: "conflict",
              message: "This project is already linked to another team. Unlink it there first.",
            });
          let next = links;
          if (!existing) {
            if (links.length >= MAX_LINKS)
              return yield* failure("Too many projects are linked on this environment.");
            next = [
              ...links,
              {
                projectId: command.projectId,
                teamId: team.id,
                storage: team.storage,
                linkedAt: DateTime.formatIso(yield* DateTime.now),
              },
            ];
            yield* writeLinks(next);
          }
          return { projects: yield* listFor(team, next), storage: null };
        }),
      );
    }
    const project = yield* activeProject(command.projectId);
    const link = (yield* readLinks).find((entry) => entry.projectId === command.projectId);
    if (!project || !link) return yield* notLinked();
    if (command.action === "project-link") {
      const team = yield* readyTeam(sessionId, link.teamId);
      return { projects: yield* listFor(team, [link]), storage: null };
    }
    const scope = { storage: link.storage };
    const teamId = link.teamId;
    const status = yield* (() => {
      switch (command.action) {
        case "memory-status":
          return storage.execute(sessionId, { action: "status", teamId }, scope);
        case "memory-list":
          return storage.execute(
            sessionId,
            { action: "list-files", teamId },
            { ...scope, listRoot: "Memory" },
          );
        case "memory-read":
          return storage.execute(
            sessionId,
            { action: "read-file", teamId, path: command.path },
            scope,
          );
        case "memory-publish":
          // The project label comes from the linked project, not the client.
          return storage.execute(
            sessionId,
            {
              action: "publish",
              teamId,
              kind: "memory",
              recordId: command.recordId,
              deviceId: command.deviceId,
              title: command.title,
              project: project.title.slice(0, 80),
              text: command.text,
            },
            scope,
          );
        case "memory-update":
          return storage.execute(
            sessionId,
            {
              action: "update-file",
              teamId,
              path: command.path,
              etag: command.etag,
              text: command.text,
            },
            scope,
          );
        case "memory-delete":
          return storage.execute(
            sessionId,
            { action: "delete-file", teamId, path: command.path, etag: command.etag },
            scope,
          );
      }
    })();
    // An unlink or relink that landed while a read was in flight wins: its content is withheld.
    if (
      (command.action === "memory-status" ||
        command.action === "memory-list" ||
        command.action === "memory-read") &&
      !sameLink(
        link,
        (yield* readLinks).find((entry) => entry.projectId === command.projectId),
      )
    )
      return yield* notLinked();
    return { projects: [], storage: status };
  });
  return TeamProjectService.of({ execute });
});

export const layer = Layer.effect(TeamProjectService, make);
