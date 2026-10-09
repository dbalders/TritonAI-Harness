import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

const Id = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
);
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
const Email = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.isPattern(/^[^\s@]+@ucsd\.edu$/iu),
);
export const TeamRole = Schema.Literals(["owner", "editor", "reader"]);
export type TeamRole = typeof TeamRole.Type;
export const TeamCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literal("create"), requestId: Id, name: Name }),
  Schema.Struct({ action: Schema.Literal("get"), teamId: Id }),
  Schema.Struct({ action: Schema.Literal("rename"), teamId: Id, name: Name, revision: Schema.Int }),
  Schema.Struct({
    action: Schema.Literal("invite"),
    teamId: Id,
    email: Email,
    role: TeamRole,
    revision: Schema.Int,
  }),
  Schema.Struct({ action: Schema.Literal("accept"), invitationId: Id, token: Identity }),
  Schema.Struct({ action: Schema.Literal("accept-pending"), invitationId: Id }),
  Schema.Struct({ action: Schema.Literal("decline"), invitationId: Id }),
  Schema.Struct({
    action: Schema.Literal("cancel-invite"),
    teamId: Id,
    invitationId: Id,
    revision: Schema.Int,
  }),
  Schema.Struct({
    action: Schema.Literal("set-role"),
    teamId: Id,
    identityId: Identity,
    role: TeamRole,
    revision: Schema.Int,
  }),
  Schema.Struct({
    action: Schema.Literal("remove-member"),
    teamId: Id,
    identityId: Identity,
    revision: Schema.Int,
  }),
  Schema.Struct({ action: Schema.Literal("leave"), teamId: Id, revision: Schema.Int }),
]);
export type TeamCommand = typeof TeamCommand.Type;
export const TeamMember = Schema.Struct({
  identityId: Identity,
  displayName: Schema.String,
  email: Email,
  role: TeamRole,
});
export type TeamMember = typeof TeamMember.Type;
export const TeamSummary = Schema.Struct({
  id: Id,
  reference: Schema.String,
  name: Name,
  role: TeamRole,
  canManage: Schema.Boolean,
  state: Schema.Literals(["provisioning", "ready", "needs-attention"]),
  revision: Schema.Int,
});
export const TeamInvitation = Schema.Struct({
  id: Id,
  teamId: Id,
  teamName: Name,
  teamReference: Schema.String,
  email: Email,
  role: TeamRole,
  expiresAt: Schema.Int,
});
export const TeamStorage = Schema.Struct({
  tenantId: Schema.String,
  siteId: Schema.String,
  driveId: Schema.String,
  folderId: Schema.String,
});
export type TeamStorage = typeof TeamStorage.Type;
export const TeamDetail = Schema.Struct({
  ...TeamSummary.fields,
  members: Schema.Array(TeamMember),
  invitations: Schema.Array(TeamInvitation),
  storage: Schema.NullOr(TeamStorage),
});
export const TeamsResult = Schema.Struct({
  teams: Schema.Array(TeamSummary),
  invitations: Schema.Array(TeamInvitation),
  team: Schema.NullOr(TeamDetail),
  invitationCode: Schema.NullOr(Schema.String),
});
export type TeamsResult = typeof TeamsResult.Type;
export class TeamsError extends Schema.TaggedError<TeamsError>()("TeamsError", {
  code: Schema.Literals([
    "not_configured",
    "sign_in_required",
    "forbidden",
    "not_found",
    "conflict",
    "invalid_request",
    "unavailable",
  ]),
  message: Schema.String,
}) {}

export const TeamStorageCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["status", "connect", "disconnect", "list-files"]),
    teamId: Id,
  }),
  Schema.Struct({
    action: Schema.Literal("poll"),
    teamId: Id,
    flowId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  }),
  Schema.Struct({
    action: Schema.Literal("publish"),
    teamId: Id,
    recordId: Id,
    deviceId: Id,
    kind: Schema.Literals(["memory", "sop", "skill"]),
    title: Name,
    project: Schema.String.check(Schema.isMaxLength(80)),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("read-file"),
    teamId: Id,
    path: Schema.String.check(Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    action: Schema.Literal("update-file"),
    teamId: Id,
    path: Schema.String.check(Schema.isMaxLength(512)),
    etag: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("delete-file"),
    teamId: Id,
    path: Schema.String.check(Schema.isMaxLength(512)),
    etag: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
]);
export type TeamStorageCommand = typeof TeamStorageCommand.Type;
/** The exact text a published team note is saved with, so a share preview matches storage. */
export const formatTeamNote = (note: { title: string; project: string; text: string }) =>
  `# ${note.title.replace(/[\r\n]/gu, " ")}\n\n${note.project.trim() ? `Project: ${note.project.replace(/[\r\n]/gu, " ")}\n\n` : ""}${note.text}`;
export const TeamDocument = Schema.Struct({
  path: Schema.String,
  etag: Schema.String,
  text: Schema.String,
});
export type TeamDocument = typeof TeamDocument.Type;
export const TeamStorageStatus = Schema.Struct({
  status: Schema.Literals(["not-configured", "disconnected", "pending", "connected"]),
  account: Schema.NullOr(Schema.String),
  flowId: Schema.NullOr(Schema.String),
  userCode: Schema.NullOr(Schema.String),
  verificationUri: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  retryAfterSeconds: Schema.NullOr(Schema.Int),
  document: Schema.NullOr(TeamDocument),
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      etag: Schema.String,
      size: Schema.Int,
    }),
  ),
});
export type TeamStorageStatus = typeof TeamStorageStatus.Type;

const MemoryPath = Schema.String.check(Schema.isMaxLength(512), Schema.isPattern(/^Memory\//u));
/** Team-memory access from a Harness project. The server resolves the team from its own binding. */
export const TeamProjectCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list"), teamId: Id }),
  Schema.Struct({ action: Schema.Literal("bind"), teamId: Id, projectId: ProjectId }),
  Schema.Struct({ action: Schema.Literal("unbind"), teamId: Id, projectId: ProjectId }),
  Schema.Struct({
    action: Schema.Literals(["memory-status", "memory-list"]),
    projectId: ProjectId,
  }),
  /** The link for a project, only when the caller can open its team. */
  Schema.Struct({ action: Schema.Literal("project-link"), projectId: ProjectId }),
  Schema.Struct({ action: Schema.Literal("memory-read"), projectId: ProjectId, path: MemoryPath }),
  /** Publishes text the user chose in a thread as a memory note; provenance comes from the server. */
  Schema.Struct({
    action: Schema.Literal("share"),
    teamId: Id,
    threadId: ThreadId,
    recordId: Id,
    deviceId: Id,
    title: Name,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("memory-publish"),
    projectId: ProjectId,
    recordId: Id,
    deviceId: Id,
    title: Name,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("memory-update"),
    projectId: ProjectId,
    path: MemoryPath,
    etag: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("memory-delete"),
    projectId: ProjectId,
    path: MemoryPath,
    etag: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  }),
]);
export type TeamProjectCommand = typeof TeamProjectCommand.Type;
export const TeamProjectLink = Schema.Struct({
  projectId: ProjectId,
  projectTitle: Schema.String,
  teamId: Id,
  teamName: Schema.String,
  linkedAt: Schema.String,
});
export type TeamProjectLink = typeof TeamProjectLink.Type;
export const TeamProjectResult = Schema.Struct({
  projects: Schema.Array(TeamProjectLink),
  storage: Schema.NullOr(TeamStorageStatus),
});
export type TeamProjectResult = typeof TeamProjectResult.Type;
