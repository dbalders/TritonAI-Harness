import {
  type ClientOrchestrationCommand,
  formatTeamContext,
  hasHiddenTeamText,
  MAX_TEAM_PROJECT_SKILL_CHARS,
  MAX_TEAM_PROJECT_SKILLS,
  type ProjectId,
  type StuckTeamProjectLink,
  type TeamContextKind,
  type ThreadId,
  type TeamProjectCommand,
  type TeamProjectLink,
  type TeamProjectResult,
  type TeamProjectSkill,
  teamNoteHeader,
  TeamStorage,
  type TeamStorageStatus,
  TeamsError,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
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
/** Memory and skill blocks handed to composers, newest last; older ones must be added again. */
const MAX_ISSUED = 256;
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
const ENABLED_SECRET_NAME = "team-project-skills";
const MAX_ENABLED = 2_000;
/**
 * A skill one campus identity turned on for one project. It applies only while the project keeps
 * the exact link it was approved under and the document's text still has the approved version.
 */
const Enabled = Schema.Struct({
  /** The caller's author-folder id: sha256 of `[issuer, subject]`, as the membership service names it. */
  identity: Schema.String,
  link: Link,
  path: Schema.String,
  /** SHA-256 hex of the exact document text that was reviewed. */
  version: Schema.String,
  title: Schema.String,
  chars: Schema.Int,
  approvedAt: Schema.String,
});
type Enabled = typeof Enabled.Type;
const EnabledList = Schema.fromJsonString(
  Schema.Array(Enabled).check(Schema.isMaxLength(MAX_ENABLED)),
);
const decodeEnabled = Schema.decodeUnknownEffect(EnabledList);
const encodeEnabled = Schema.encodeEffect(EnabledList);
const identityOf = (profile: { issuer: string; subject: string }) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify([profile.issuer, profile.subject]))
    .digest("base64url");
const versionOf = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
/** Losing the team itself, as opposed to failing to check it. */
const lostTeam = (error: TeamsError) => error.code === "not_found" || error.code === "forbidden";
const failure = (message: string) => new TeamsError({ code: "unavailable", message });
const notLinked = () =>
  new TeamsError({
    code: "not_found",
    message: "This project is not linked to a team you can open. Link it from Teams.",
  });
const storageUnavailable = (status: TeamStorageStatus["status"]) =>
  new TeamsError({
    code: "unavailable",
    message:
      status === "not-configured"
        ? "Microsoft storage is not set up for this environment yet."
        : "Connect Microsoft in Teams → your team → Shared storage, then try again.",
  });
const folders = { memory: "Memory", skill: "Skills" } as const;
/** Documents a project's memory or skill list titles; the rest show their titles once previewed. */
const LIST_SUMMARIES = 20;
/** The one top-level team folder a project command may touch; the contract pins its path too. */
const folderOf = (
  command: Extract<TeamProjectCommand, { projectId: ProjectId }>,
): (typeof folders)[TeamContextKind] | null =>
  command.action.startsWith("skill-")
    ? folders.skill
    : command.action.startsWith("memory-")
      ? folders.memory
      : null;
const wrongFolder = () =>
  new TeamsError({
    code: "invalid_request",
    message: "Only this team's memory notes and skills can be opened here.",
  });
const hiddenSkillText = () =>
  new TeamsError({
    code: "invalid_request",
    message:
      "This skill contains hidden or control characters, so Harness won't use it. Ask its author to remove them in Teams → Shared storage.",
  });
/** A team memory or skill block this server issued, and the authority it was issued under. */
interface Issued {
  readonly id: string;
  readonly sessionId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly projectId: ProjectId;
  readonly link: Link;
  readonly block: string;
  /** Added by the server to a message because its skill is on for the project; never handed out. */
  readonly applied?: true;
}
/** An enabled skill as checked for one request, with the approved text when it can be used. */
interface CheckedSkill {
  readonly skill: TeamProjectSkill;
  readonly text?: string;
}

/**
 * Links a local Harness project to one team's shared memory and skills. The link is local
 * metadata, not a filesystem boundary: every call reresolves the team from this server-side
 * record and rechecks the caller's campus identity, membership, role, and the exact storage root.
 * Team content is never written into the project workspace, personal memory, provider homes, or
 * installed skills. It reaches an agent only as text in a user's message: added by the user, or
 * added by the server to each message in a project where that user turned an approved skill on.
 */
export class TeamProjectService extends Context.Service<
  TeamProjectService,
  {
    readonly execute: (
      sessionId: string,
      command: TeamProjectCommand,
    ) => Effect.Effect<TeamProjectResult, TeamsError>;
    /**
     * Refuses a client's message or goal text that contains a team memory or skill block this
     * server issued unless the sending session can still open that block's team through the same
     * link and root.
     * Defense in depth for the WebSocket and HTTP client dispatch only: it recognizes blocks still
     * in memory (not after a restart or once evicted), and host MCP tools do not pass through it.
     * The client's `memory-verify` before each send is what holds edited and older notes.
     */
    readonly authorizeOutgoingCommand: (
      sessionId: string,
      command: ClientOrchestrationCommand,
    ) => Effect.Effect<void, TeamsError>;
    /**
     * What a client dispatch sends: `authorizeOutgoingCommand`, then, for a user message in a
     * linked project, the approved skills this session's campus identity turned on for that
     * project, each rechecked now. A skill whose access is gone, whose document changed or was
     * removed, is left out; a check that can't complete fails the send. Slash commands and other
     * commands pass unchanged.
     */
    readonly prepareOutgoingCommand: (
      sessionId: string,
      command: ClientOrchestrationCommand,
    ) => Effect.Effect<ClientOrchestrationCommand, TeamsError>;
  }
>()("t3/teams/TeamProjectService") {}

export const make = Effect.gen(function* () {
  const account = yield* AccountService;
  const storage = yield* TeamStorageService;
  const secrets = yield* ServerSecretStore;
  const projects = yield* ProjectionSnapshotQuery;
  const lock = yield* Semaphore.make(1);
  // In memory on purpose. After a restart or eviction `memory-verify` refuses the old reference,
  // while the dispatch gate no longer recognizes its block and treats it as ordinary text.
  const issued = new Map<string, Issued>();

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
  const readEnabled = secrets.get(ENABLED_SECRET_NAME).pipe(
    Effect.flatMap((value) =>
      Option.isSome(value)
        ? decodeEnabled(new TextDecoder().decode(value.value))
        : Effect.succeed([] as readonly Enabled[]),
    ),
    Effect.mapError(() => failure("Team skill settings could not be read securely.")),
  );
  const writeEnabled = (entries: readonly Enabled[]) =>
    encodeEnabled(entries).pipe(
      Effect.flatMap((encoded) =>
        secrets.set(ENABLED_SECRET_NAME, new TextEncoder().encode(encoded)),
      ),
      Effect.mapError(() => failure("Team skill settings could not be saved securely.")),
    );
  /** Turns off the matching skills; callers hold `lock`. */
  const removeEnabled = (matches: (entry: Enabled) => boolean) =>
    Effect.gen(function* () {
      const entries = yield* readEnabled;
      const next = entries.filter((entry) => !matches(entry));
      if (next.length !== entries.length) yield* writeEnabled(next);
    });
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

  const signedInProfile = (sessionId: string) =>
    account.getStatus(sessionId).pipe(
      Effect.mapError(() => failure("Your UC San Diego account could not be verified.")),
      Effect.flatMap((status) =>
        status.status === "signed-in" && status.profile
          ? Effect.succeed(status.profile)
          : Effect.fail(
              new TeamsError({
                code: "sign_in_required",
                message: "Sign in with UC San Diego to use team memory.",
              }),
            ),
      ),
    );
  const linkFor = (projectId: string) =>
    readLinks.pipe(Effect.map((links) => links.find((entry) => entry.projectId === projectId)));
  const memoryChanged = () =>
    new TeamsError({
      code: "conflict",
      message: "Team access changed while this was checked. Try again.",
    });
  /**
   * Whether this session can still send an issued block: signed in, the project still linked to
   * the same team and root it was issued under, and a ready member of that exact team now.
   * Owned references must also come from the same session and campus identity that received them.
   */
  const authorizeIssued = (sessionId: string, entry: Issued, owned: boolean) =>
    Effect.gen(function* () {
      const profile = yield* signedInProfile(sessionId);
      if (
        owned &&
        (entry.sessionId !== sessionId ||
          entry.issuer !== profile.issuer ||
          entry.subject !== profile.subject)
      )
        return yield* new TeamsError({
          code: "sign_in_required",
          message: "This team memory was added under another account. Remove it to send.",
        });
      const unchangedLink = Effect.gen(function* () {
        if (!sameLink(entry.link, yield* linkFor(entry.projectId)))
          return yield* new TeamsError({
            code: "not_found",
            message: "This project's team link changed since the memory was added.",
          });
        if (!(yield* activeProject(entry.projectId))) return yield* notLinked();
      });
      yield* unchangedLink;
      const team = yield* readyTeam(sessionId, entry.link.teamId);
      const root = entry.link.storage;
      if (
        team.storage.tenantId.toLowerCase() !== root.tenantId.toLowerCase() ||
        team.storage.siteId !== root.siteId ||
        team.storage.driveId !== root.driveId ||
        team.storage.folderId !== root.folderId
      )
        return yield* new TeamsError({
          code: "conflict",
          message: "This team's folder changed since the memory was added.",
        });
      // An account switch or unlink that landed during the membership check wins.
      const after = yield* signedInProfile(sessionId);
      if (after.issuer !== profile.issuer || after.subject !== profile.subject)
        return yield* memoryChanged();
      yield* unchangedLink;
    });
  const remember = (entry: Issued) => {
    issued.set(entry.id, entry);
    for (const id of issued.keys()) {
      if (issued.size <= MAX_ISSUED) break;
      issued.delete(id);
    }
  };
  /** Holds a block the server added to a message, replacing its earlier copy for the same authority. */
  const rememberApplied = (entry: Issued) => {
    for (const [id, existing] of issued)
      if (
        existing.applied &&
        existing.block === entry.block &&
        existing.sessionId === entry.sessionId &&
        existing.issuer === entry.issuer &&
        existing.subject === entry.subject &&
        existing.projectId === entry.projectId &&
        sameLink(existing.link, entry.link)
      )
        issued.delete(id);
    remember(entry);
  };

  /**
   * The caller's link, team, and own skills for a project, after the membership check every use
   * of them makes. Losing the team turns the caller's skills for the project off.
   */
  const projectSkills = (
    sessionId: string,
    projectId: ProjectId,
    profile: { issuer: string; subject: string },
  ) =>
    Effect.gen(function* () {
      const link = yield* linkFor(projectId);
      if (!link || !(yield* activeProject(projectId))) return yield* notLinked();
      const identity = identityOf(profile);
      const mineFor = (entry: Enabled) =>
        entry.identity === identity && entry.link.projectId === projectId;
      const team = yield* readyTeam(sessionId, link.teamId).pipe(
        Effect.tapError((error) =>
          lostTeam(error) ? lock.withPermits(1)(removeEnabled(mineFor)) : Effect.void,
        ),
      );
      const root = link.storage;
      if (
        team.storage.tenantId.toLowerCase() !== root.tenantId.toLowerCase() ||
        team.storage.siteId !== root.siteId ||
        team.storage.driveId !== root.driveId ||
        team.storage.folderId !== root.folderId
      )
        return yield* new TeamsError({
          code: "conflict",
          message: "This project's team folder changed. Unlink the project and link it again.",
        });
      // Skills approved under an earlier link of this project never apply to the current one.
      const mine = (yield* readEnabled).filter(
        (entry) => mineFor(entry) && sameLink(entry.link, link),
      );
      return { link, team, identity, mine };
    });
  /**
   * Rereads each of the caller's skills for the project now. A removed, changed, or hidden-text
   * document is withheld with its reason, as are all of them when this session has no working
   * Microsoft connection; a read that can't complete fails.
   */
  const checkSkills = (
    sessionId: string,
    link: Link,
    mine: readonly Enabled[],
  ): Effect.Effect<CheckedSkill[], TeamsError> =>
    Effect.forEach(mine, (entry) =>
      Effect.gen(function* () {
        const base = { path: entry.path, title: entry.title, version: entry.version } as const;
        const read = yield* storage
          .execute(
            sessionId,
            { action: "read-file", teamId: link.teamId, path: entry.path },
            { storage: link.storage },
          )
          .pipe(Effect.result);
        if (read._tag === "Failure") {
          if (read.failure.code === "sign_in_required")
            return {
              skill: { ...base, state: "unavailable", reason: read.failure.message },
            } satisfies CheckedSkill;
          if (read.failure.code !== "not_found") return yield* read.failure;
          return {
            skill: {
              ...base,
              state: "unavailable",
              reason: "This skill is no longer in the team's Skills folder.",
            },
          } satisfies CheckedSkill;
        }
        const document = read.success.document;
        if (!document)
          return {
            skill: {
              ...base,
              state: "unavailable",
              reason: storageUnavailable(read.success.status).message,
            },
          } satisfies CheckedSkill;
        const current = versionOf(document.text);
        if (hasHiddenTeamText(document.text))
          return {
            skill: {
              ...base,
              state: "unavailable",
              reason:
                "This skill now contains hidden or control characters, so Harness won't use it.",
              currentVersion: current,
            },
          } satisfies CheckedSkill;
        if (current !== entry.version)
          return {
            skill: {
              ...base,
              state: "needs-review",
              reason:
                "This skill changed since you turned it on. Review the update to use it again.",
              currentVersion: current,
            },
          } satisfies CheckedSkill;
        return { skill: { ...base, state: "active" }, text: document.text } satisfies CheckedSkill;
      }),
    );
  const projectOf = (command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>) =>
    projects.getThreadShellById(command.threadId).pipe(
      Effect.mapError(() => failure("The thread could not be read.")),
      Effect.map((thread) =>
        Option.isSome(thread)
          ? thread.value.projectId
          : (command.bootstrap?.createThread?.projectId ?? null),
      ),
    );
  /** Adds the session's active project skills to a user message; see `prepareOutgoingCommand`. */
  const applyProjectSkills = Effect.fn("TeamProjectService.applyProjectSkills")(function* (
    sessionId: string,
    command: ClientOrchestrationCommand,
  ) {
    if (command.type !== "thread.turn.start") return command;
    const text = command.message.text;
    // A slash command must reach the provider exactly as typed.
    if (text.trimStart().startsWith("/")) return command;
    // Unreadable settings add nothing rather than stop every message on this server; Settings →
    // Skills reports the error.
    const enabled = yield* readEnabled.pipe(
      Effect.tapError((error) => Effect.logWarning("team skill settings unreadable", error)),
      Effect.orElseSucceed((): readonly Enabled[] => []),
    );
    if (enabled.length === 0) return command;
    const projectId = yield* projectOf(command);
    if (!projectId || !enabled.some((entry) => entry.link.projectId === projectId)) return command;
    const status = yield* account
      .getStatus(sessionId)
      .pipe(Effect.mapError(() => failure("Your UC San Diego account could not be verified.")));
    // Only the signed-in identity's own choices apply; nobody else's ever do.
    if (status.status !== "signed-in" || !status.profile) return command;
    const profile = status.profile;
    const identity = identityOf(profile);
    if (!enabled.some((entry) => entry.identity === identity && entry.link.projectId === projectId))
      return command;
    const cannotCheck = (error: TeamsError) =>
      new TeamsError({
        code: "unavailable",
        message: `Team skills are on for this project, but they couldn't be checked. ${error.message} Try again, or turn them off in Settings → Skills.`,
      });
    const context = yield* projectSkills(sessionId, projectId, profile).pipe(Effect.result);
    if (context._tag === "Failure") {
      // A team the caller lost, or a link that's gone, withholds its skills; the message goes.
      if (context.failure.code !== "unavailable" && context.failure.code !== "conflict")
        return command;
      return yield* cannotCheck(context.failure);
    }
    const { link, team, identity: owner, mine } = context.success;
    if (mine.length === 0) return command;
    const checked = yield* checkSkills(sessionId, link, mine).pipe(Effect.mapError(cannotCheck));
    const entries: (Issued & { readonly path: string; readonly version: string })[] = [];
    for (const { skill, text: skillText } of checked) {
      if (skill.state !== "active" || skillText === undefined) continue;
      // A skill the user also added to this message by hand is already there.
      const added = formatTeamContext({
        kind: "skill",
        teamName: team.name,
        path: skill.path,
        text: "",
      });
      if (text.includes(added.slice(0, added.indexOf(">")))) continue;
      entries.push({
        path: skill.path,
        version: skill.version,
        id: NodeCrypto.randomUUID(),
        sessionId,
        issuer: profile.issuer,
        subject: profile.subject,
        projectId,
        link,
        applied: true,
        block: formatTeamContext({
          kind: "skill",
          teamName: team.name,
          path: skill.path,
          text: skillText,
          projectVersion: skill.version,
        }),
      });
    }
    if (entries.length === 0) return command;
    // The same check the dispatch gate makes: an account switch or unlink during the reads wins.
    const held = yield* authorizeIssued(sessionId, entries[0]!, true).pipe(Effect.result);
    if (held._tag === "Failure") {
      if (held.failure.code === "unavailable") return yield* cannotCheck(held.failure);
      return command;
    }
    // A skill turned off, or an update approved, while it was being read is decided by the
    // approval as it stands now: only the exact version still approved is added.
    const approved = yield* readEnabled.pipe(Effect.orElseSucceed((): readonly Enabled[] => []));
    const applied = entries.filter((entry) =>
      approved.some(
        (current) =>
          current.identity === owner &&
          current.link.projectId === projectId &&
          sameLink(current.link, link) &&
          current.path === entry.path &&
          current.version === entry.version,
      ),
    );
    if (applied.length === 0) return command;
    for (const { path: _path, version: _version, ...entry } of applied) rememberApplied(entry);
    const blocks = applied.map((entry) => entry.block).join("\n\n");
    return {
      ...command,
      message: { ...command.message, text: text.trim() ? `${text}\n\n${blocks}` : blocks },
    };
  });
  const enabledSkills = Effect.fn("TeamProjectService.enabledSkills")(function* (
    sessionId: string,
    projectId: ProjectId,
  ) {
    const profile = yield* signedInProfile(sessionId);
    const context = yield* projectSkills(sessionId, projectId, profile).pipe(Effect.result);
    if (context._tag === "Failure") {
      // A team that can't be checked now fails sends that would carry the caller's skills, so
      // show their own approvals, as recorded, to turn off. Nothing is read from the team.
      const error = context.failure;
      const link = yield* linkFor(projectId);
      const identity = identityOf(profile);
      const own = link
        ? (yield* readEnabled).filter(
            (entry) =>
              entry.identity === identity &&
              entry.link.projectId === projectId &&
              sameLink(entry.link, link),
          )
        : [];
      if ((error.code !== "unavailable" && error.code !== "conflict") || own.length === 0)
        return yield* error;
      // An account switch, sign-out, or unlink that landed during the failed lookup wins.
      const after = yield* signedInProfile(sessionId);
      if (
        after.issuer !== profile.issuer ||
        after.subject !== profile.subject ||
        link === undefined ||
        !sameLink(link, yield* linkFor(projectId))
      )
        return yield* memoryChanged();
      return {
        projects: [],
        storage: null,
        problem: error.message,
        enabledSkills: own.map((entry): TeamProjectSkill => ({
          path: entry.path,
          title: entry.title,
          version: entry.version,
          state: "unavailable",
          reason: error.message,
        })),
      };
    }
    const { link, team, mine } = context.success;
    const checked = yield* checkSkills(sessionId, link, mine).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          mine.map((entry): CheckedSkill => ({
            skill: {
              path: entry.path,
              title: entry.title,
              version: entry.version,
              state: "unavailable",
              reason: error.message,
            },
          })),
        ),
      ),
    );
    // An unlink or account switch that landed during the reads wins.
    const after = yield* signedInProfile(sessionId);
    if (
      after.issuer !== profile.issuer ||
      after.subject !== profile.subject ||
      !sameLink(link, yield* linkFor(projectId))
    )
      return yield* memoryChanged();
    return {
      projects: yield* listFor(team, [link]),
      storage: null,
      enabledSkills: checked.map((entry) => entry.skill),
    };
  });
  const enableSkill = Effect.fn("TeamProjectService.enableSkill")(function* (
    sessionId: string,
    command: Extract<TeamProjectCommand, { action: "skill-enable" }>,
  ) {
    if (!command.path.startsWith(`${folders.skill}/`)) return yield* wrongFolder();
    const profile = yield* signedInProfile(sessionId);
    const { link, identity } = yield* projectSkills(sessionId, command.projectId, profile);
    const status = yield* storage.execute(
      sessionId,
      { action: "read-file", teamId: link.teamId, path: command.path },
      { storage: link.storage },
    );
    const document = status.document;
    if (!document) return yield* storageUnavailable(status.status);
    if (hasHiddenTeamText(document.text)) return yield* hiddenSkillText();
    if (versionOf(document.text) !== command.version)
      return yield* new TeamsError({
        code: "conflict",
        message: "This skill changed since you reviewed it. Review it again to turn it on.",
      });
    // An account switch or unlink that landed during the read wins.
    const after = yield* signedInProfile(sessionId);
    if (
      after.issuer !== profile.issuer ||
      after.subject !== profile.subject ||
      !sameLink(link, yield* linkFor(command.projectId))
    )
      return yield* memoryChanged();
    const approvedAt = DateTime.formatIso(yield* DateTime.now);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const entries = yield* readEnabled;
        const mineFor = (entry: Enabled) =>
          entry.identity === identity && entry.link.projectId === command.projectId;
        const others = entries.filter(
          (entry) => mineFor(entry) && sameLink(entry.link, link) && entry.path !== command.path,
        );
        if (others.length >= MAX_TEAM_PROJECT_SKILLS)
          return yield* new TeamsError({
            code: "invalid_request",
            message: `At most ${MAX_TEAM_PROJECT_SKILLS} team skills can be on for one project, because each is added to every message. Turn one off first.`,
          });
        if (
          others.reduce((total, entry) => total + entry.chars, 0) + document.text.length >
          MAX_TEAM_PROJECT_SKILL_CHARS
        )
          return yield* new TeamsError({
            code: "invalid_request",
            message: `Team skills on for one project can total at most ${MAX_TEAM_PROJECT_SKILL_CHARS.toLocaleString("en-US")} characters, because they're added to every message. Turn another off, or use this one in a single message instead.`,
          });
        const approved: Enabled = {
          identity,
          link,
          path: command.path,
          version: command.version,
          title: teamNoteHeader(document.text).title || command.path.split("/").at(-1)!,
          chars: document.text.length,
          approvedAt,
        };
        // An approved update keeps its place; skills from an earlier link of the project go.
        let replaced = false;
        const next = entries.flatMap((entry) => {
          if (!mineFor(entry)) return [entry];
          if (!sameLink(entry.link, link)) return [];
          if (entry.path !== command.path) return [entry];
          replaced = true;
          return [approved];
        });
        if (!replaced) next.push(approved);
        if (next.length > MAX_ENABLED)
          return yield* failure("Too many team skills are on in this environment.");
        yield* writeEnabled(next);
        return { projects: [], storage: null };
      }),
    );
  });
  const disableSkill = Effect.fn("TeamProjectService.disableSkill")(function* (
    sessionId: string,
    command: Extract<TeamProjectCommand, { action: "skill-disable" }>,
  ) {
    // Turning a skill off only reduces what is sent, so it needs no team or link.
    const identity = identityOf(yield* signedInProfile(sessionId));
    yield* lock.withPermits(1)(
      removeEnabled(
        (entry) =>
          entry.identity === identity &&
          entry.link.projectId === command.projectId &&
          entry.path === command.path,
      ),
    );
    return { projects: [], storage: null };
  });
  const disableAllSkills = Effect.fn("TeamProjectService.disableAllSkills")(function* (
    sessionId: string,
    projectId: ProjectId,
  ) {
    // Like turning one off, this only reduces what is sent, so it needs no team, link, or read.
    const identity = identityOf(yield* signedInProfile(sessionId));
    yield* lock.withPermits(1)(
      removeEnabled((entry) => entry.identity === identity && entry.link.projectId === projectId),
    );
    return { projects: [], storage: null, enabledSkills: [] };
  });
  const projectLinks = Effect.fn("TeamProjectService.projectLinks")(function* (sessionId: string) {
    yield* signedInProfile(sessionId);
    const teams = new Map(
      (yield* account.teams(sessionId, { action: "list" })).teams
        .filter((team) => team.state === "ready")
        .map((team) => [team.id, team] as const),
    );
    const result: TeamProjectLink[] = [];
    for (const link of yield* readLinks) {
      const team = teams.get(link.teamId);
      if (team) result.push(...(yield* listFor(team, [link])));
    }
    return { projects: result, storage: null };
  });

  /**
   * Links in this environment that the caller can't use or unlink from a team page: their team
   * isn't one the caller belongs to, or isn't ready. A link to a ready team is never listed.
   */
  const stuckLinks = Effect.fn("TeamProjectService.stuckLinks")(function* (sessionId: string) {
    yield* signedInProfile(sessionId);
    const teams = new Map(
      (yield* account.teams(sessionId, { action: "list" })).teams.map(
        (team) => [team.id, team] as const,
      ),
    );
    const result: StuckTeamProjectLink[] = [];
    for (const link of yield* readLinks) {
      const team = teams.get(link.teamId);
      if (team?.state === "ready") continue;
      const project = yield* activeProject(link.projectId as ProjectId);
      if (project)
        result.push({
          projectId: project.id,
          projectTitle: project.title,
          teamName: team?.name ?? null,
          reason: team ? "held" : "no-access",
          linkedAt: link.linkedAt,
        });
    }
    return { projects: [], storage: null, stuckLinks: result };
  });
  /**
   * Removes a link whose team the caller can't open or that isn't ready. The link is this
   * environment's own record and removing it only reduces access, so it needs no team; a team the
   * caller can open is unlinked from its page instead, so that stays the one ordinary path.
   */
  const removeLink = Effect.fn("TeamProjectService.removeLink")(function* (
    sessionId: string,
    projectId: ProjectId,
  ) {
    yield* signedInProfile(sessionId);
    const link = yield* linkFor(projectId);
    if (!link) return { projects: [], storage: null };
    const team = yield* account.teams(sessionId, { action: "get", teamId: link.teamId }).pipe(
      Effect.map((result) => result.team),
      // A check that can't complete is not evidence the team is gone.
      Effect.catch((error) => (lostTeam(error) ? Effect.succeed(null) : Effect.fail(error))),
    );
    if (team?.id === link.teamId && team.state === "ready")
      return yield* new TeamsError({
        code: "conflict",
        message: "You can open this project's team now. Unlink the project from that team.",
      });
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const links = yield* readLinks;
        const current = links.find((entry) => entry.projectId === projectId);
        if (!current) return { projects: [], storage: null };
        // A relink landed during the check: that link wasn't the one checked.
        if (!sameLink(link, current))
          return yield* new TeamsError({
            code: "conflict",
            message: "This project's team link changed. Refresh and try again.",
          });
        yield* writeLinks(links.filter((entry) => entry.projectId !== projectId));
        // As with unlinking, skills turned on under the removed link never apply again.
        yield* removeEnabled((entry) => entry.link.projectId === projectId);
        return { projects: [], storage: null };
      }),
    );
  });

  const attach = Effect.fn("TeamProjectService.attach")(function* (
    sessionId: string,
    command: Extract<TeamProjectCommand, { action: "memory-attach" | "skill-attach" }>,
  ) {
    const kind: TeamContextKind = command.action === "skill-attach" ? "skill" : "memory";
    if (!command.path.startsWith(`${folders[kind]}/`)) return yield* wrongFolder();
    const profile = yield* signedInProfile(sessionId);
    const link = yield* linkFor(command.projectId);
    if (!link || !(yield* activeProject(command.projectId))) return yield* notLinked();
    const team = yield* readyTeam(sessionId, link.teamId);
    const status = yield* storage.execute(
      sessionId,
      { action: "read-file", teamId: link.teamId, path: command.path },
      { storage: link.storage },
    );
    const document = status.document;
    if (!document) return yield* storageUnavailable(status.status);
    if (kind === "skill" && hasHiddenTeamText(document.text)) return yield* hiddenSkillText();
    const entry: Issued = {
      id: NodeCrypto.randomUUID(),
      sessionId,
      issuer: profile.issuer,
      subject: profile.subject,
      projectId: command.projectId,
      link,
      block: formatTeamContext({
        kind,
        teamName: team.name,
        path: document.path,
        text: document.text,
      }),
    };
    // The read must still hold for the same account and link when it is handed out.
    yield* authorizeIssued(sessionId, entry, true);
    remember(entry);
    return {
      projects: [],
      // The document the block was made from, so a changed one is reviewed under its current title.
      storage: status,
      reference: {
        id: entry.id,
        kind,
        projectId: entry.projectId,
        teamName: team.name,
        path: document.path,
        block: entry.block,
      },
    };
  });
  const verify = Effect.fn("TeamProjectService.verify")(function* (
    sessionId: string,
    references: readonly string[],
  ) {
    for (const id of new Set(references)) {
      const entry = issued.get(id);
      if (!entry)
        return yield* new TeamsError({
          code: "not_found",
          message: "This team memory has expired. Remove it and add it again.",
        });
      yield* authorizeIssued(sessionId, entry, true);
    }
    return { projects: [], storage: null };
  });
  const authorizeOutgoingCommand = Effect.fn("TeamProjectService.authorizeOutgoingCommand")(
    function* (sessionId: string, command: ClientOrchestrationCommand) {
      const text =
        command.type === "thread.turn.start"
          ? command.message.text
          : command.type === "thread.goal.set"
            ? (command.objective ?? "")
            : "";
      if (!text || issued.size === 0) return;
      // A block passes when any issuance of it, newest first, still holds for this session, so
      // memory added again after a relink is not refused for its older, stale issuance.
      const refused = new Map<string, TeamsError | null>();
      for (const entry of [...issued.values()].toReversed()) {
        if (refused.get(entry.block) === null || !text.includes(entry.block)) continue;
        const result = yield* Effect.result(authorizeIssued(sessionId, entry, false));
        refused.set(
          entry.block,
          result._tag === "Success" ? null : (refused.get(entry.block) ?? result.failure),
        );
      }
      for (const error of refused.values())
        if (error)
          return yield* new TeamsError({
            code: error.code,
            message: `This message contains team memory you can no longer send. ${error.message}`,
          });
    },
  );

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
    if (command.action === "memory-attach" || command.action === "skill-attach")
      return yield* attach(sessionId, command);
    if (command.action === "memory-verify") return yield* verify(sessionId, command.references);
    if (command.action === "project-links") return yield* projectLinks(sessionId);
    if (command.action === "stuck-links") return yield* stuckLinks(sessionId);
    if (command.action === "remove-link") return yield* removeLink(sessionId, command.projectId);
    if (command.action === "skill-enabled")
      return yield* enabledSkills(sessionId, command.projectId);
    if (command.action === "skill-enable") return yield* enableSkill(sessionId, command);
    if (command.action === "skill-disable") return yield* disableSkill(sessionId, command);
    if (command.action === "skill-disable-all")
      return yield* disableAllSkills(sessionId, command.projectId);
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
            // Skills turned on under the old link never apply to a later one.
            yield* removeEnabled((entry) => entry.link.projectId === command.projectId);
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
              message:
                "This project is already linked to another team. Unlink it there first, or remove it under Stuck project links if you can't open that team.",
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
    const folder = folderOf(command);
    if (folder === null || ("path" in command && !command.path.startsWith(`${folder}/`)))
      return yield* wrongFolder();
    const scope = { storage: link.storage };
    const teamId = link.teamId;
    const browsing =
      command.action === "memory-list" ||
      command.action === "memory-read" ||
      command.action === "skill-list" ||
      command.action === "skill-read";
    const history =
      command.action === "memory-versions" ||
      command.action === "skill-versions" ||
      command.action === "memory-read-version" ||
      command.action === "skill-read-version";
    const reading = browsing || history || command.action === "memory-status";
    const status = yield* (() => {
      switch (command.action) {
        case "memory-status":
          return storage.execute(sessionId, { action: "status", teamId }, scope);
        case "memory-list":
        case "skill-list":
          return storage.execute(
            sessionId,
            { action: "list-files", teamId },
            { ...scope, listRoot: folder, summaries: LIST_SUMMARIES },
          );
        case "memory-read":
        case "skill-read":
          return storage.execute(
            sessionId,
            { action: "read-file", teamId, path: command.path },
            scope,
          );
        case "memory-versions":
        case "skill-versions":
          return storage.execute(
            sessionId,
            { action: "list-versions", teamId, path: command.path },
            scope,
          );
        case "memory-read-version":
        case "skill-read-version":
          return storage.execute(
            sessionId,
            { action: "read-version", teamId, path: command.path, versionId: command.versionId },
            scope,
          );
        case "memory-publish":
        case "skill-publish":
          // The project label comes from the linked project, not the client.
          return storage.execute(
            sessionId,
            {
              action: "publish",
              teamId,
              kind: command.action === "skill-publish" ? "skill" : "memory",
              recordId: command.recordId,
              deviceId: command.deviceId,
              title: command.title,
              ...(command.action === "skill-publish" ? { description: command.description } : {}),
              project: project.title.slice(0, 80),
              text: command.text,
            },
            scope,
          );
        case "memory-update":
        case "skill-update":
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
        case "skill-delete":
          return storage.execute(
            sessionId,
            { action: "delete-file", teamId, path: command.path, etag: command.etag },
            scope,
          );
      }
    })();
    // Names for author folders, from the same membership read every call makes.
    const authors =
      browsing && status.status === "connected"
        ? Object.fromEntries(
            (yield* readyTeam(sessionId, teamId)).members.map((member) => [
              member.identityId,
              member.displayName,
            ]),
          )
        : undefined;
    // An unlink or relink that landed while a read was in flight wins: its content is withheld.
    if (
      reading &&
      !sameLink(
        link,
        (yield* readLinks).find((entry) => entry.projectId === command.projectId),
      )
    )
      return yield* notLinked();
    if (
      command.action === "skill-read" &&
      status.document &&
      hasHiddenTeamText(status.document.text)
    )
      return yield* hiddenSkillText();
    return {
      projects: [],
      storage: status,
      ...(authors ? { authors } : {}),
      ...(command.action === "skill-read" && status.document
        ? { version: versionOf(status.document.text) }
        : {}),
    };
  });
  const prepareOutgoingCommand = Effect.fn("TeamProjectService.prepareOutgoingCommand")(function* (
    sessionId: string,
    command: ClientOrchestrationCommand,
  ) {
    yield* authorizeOutgoingCommand(sessionId, command);
    const prepared = yield* applyProjectSkills(sessionId, command);
    // Skill reads can outlive an unlink or account change, even when they add no skills.
    yield* authorizeOutgoingCommand(sessionId, prepared);
    return prepared;
  });
  return TeamProjectService.of({ execute, authorizeOutgoingCommand, prepareOutgoingCommand });
});

export const layer = Layer.effect(TeamProjectService, make);
