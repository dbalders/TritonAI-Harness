import {
  formatTeamContext,
  shortTeamSkillVersion,
  teamNoteHeader,
  type EnvironmentId,
  type ProjectId,
  type TeamDocument,
  type TeamProjectLink,
  type TeamProjectSkill,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useOptionalSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { teamProjectSkillRows, type TeamProjectSkillState } from "./teamProjectSkills";
import { useTeamProjectRequest } from "./TeamProjects";
import { SignedIn, storageProblem } from "./ThreadTeamDialogs";
import {
  teamDocumentAuthor,
  teamDocumentChange,
  type TeamListedDocument,
} from "./threadTeamContext";

const badges: Record<
  TeamProjectSkillState,
  { label: string; variant: "outline" | "success" | "warning" }
> = {
  off: { label: "Off", variant: "outline" },
  on: { label: "On", variant: "success" },
  "needs-review": { label: "Update to review", variant: "warning" },
  "not-applied": { label: "Not applied", variant: "warning" },
};

/**
 * Team skills on the Skills settings page. They are turned on per project, so they follow the
 * project chosen in the settings scope above; without one, the linked projects are offered.
 */
export function TeamSkillsSettingsSection() {
  const scope = useOptionalSettingsScope();
  if (!scope || scope.scope.kind === "unavailable") return null;
  const projectTargets = scope.targets.filter((target) => target.projectId !== null);
  const projectTitle =
    scope.scope.kind === "project" || scope.scope.kind === "checkout"
      ? scope.scope.group.displayName
      : null;
  return (
    <SettingsSection
      {...searchableSetting("team-skills")}
      icon={<UsersIcon className="size-3.5" />}
    >
      {projectTitle !== null ? (
        projectTargets.length === 0 ? (
          <SettingsRow
            title="Environment not connected"
            description={`Connect the environment ${projectTitle} is on to see its team skills.`}
          />
        ) : (
          projectTargets.map((target) => (
            <SignedIn key={target.environmentId} environmentId={target.environmentId}>
              {(identity) => (
                <ProjectTeamSkills
                  key={`${identity}:${target.projectId}`}
                  environmentId={target.environmentId}
                  projectId={target.projectId as ProjectId}
                  projectTitle={projectTitle}
                  environmentLabel={projectTargets.length > 1 ? target.label : null}
                />
              )}
            </SignedIn>
          ))
        )
      ) : (
        scope.targets.map((target) => (
          <SignedIn key={target.environmentId} environmentId={target.environmentId}>
            {(identity) => (
              <LinkedProjects
                key={identity}
                environmentId={target.environmentId}
                onChoose={(projectId) => {
                  const group = scope.groups.find((candidate) =>
                    candidate.memberProjects.some(
                      (member) =>
                        member.environmentId === target.environmentId && member.id === projectId,
                    ),
                  );
                  if (group)
                    scope.selectScope({ project: group.projectKey, machine: scope.search.machine });
                }}
              />
            )}
          </SignedIn>
        ))
      )}
    </SettingsSection>
  );
}

/** Projects in one environment linked to a team the user can open, to choose one from. */
function LinkedProjects({
  environmentId,
  onChoose,
}: {
  environmentId: EnvironmentId;
  onChoose: (projectId: ProjectId) => void;
}) {
  const { run, error } = useTeamProjectRequest(environmentId);
  const [links, setLinks] = useState<readonly TeamProjectLink[] | null>(null);
  useEffect(() => {
    void run({ action: "project-links" }).then((result) => {
      if (result && !("error" in result)) setLinks(result.projects);
    });
  }, [run]);
  if (error) return <SettingsRow title="Team skills unavailable" description={error} />;
  if (links === null)
    return <SettingsRow title="Team skills" description="Checking your linked projects…" />;
  if (links.length === 0)
    return (
      <SettingsRow
        title="No linked projects"
        description={
          <>
            Skills your teams share appear here for a project linked to a team. Link one from{" "}
            <Link to="/teams" className="underline">
              Teams
            </Link>{" "}
            → your team → Team projects.
          </>
        }
      />
    );
  return (
    <>
      <SettingsRow
        title="Choose a project"
        description="Team skills are turned on for one project at a time. Choose a project above, or one of these linked projects."
      />
      {links.map((link) => (
        <SettingsRow
          key={link.projectId}
          title={link.projectTitle}
          description={`Linked to ${link.teamName}`}
          control={
            <Button
              size="xs"
              variant="outline"
              aria-label={`Show team skills for ${link.projectTitle}`}
              onClick={() => onChoose(link.projectId)}
            >
              Show skills
            </Button>
          }
        />
      ))}
    </>
  );
}

interface Review {
  readonly document: TeamDocument;
  readonly version: string;
  /** Turning a skill on, approving its update, or looking at the instructions in use. */
  readonly mode: "enable" | "update" | "view";
  readonly changed: boolean;
}

/** One linked project's team skills, with whether each is on for the signed-in user. */
function ProjectTeamSkills({
  environmentId,
  projectId,
  projectTitle,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectTitle: string;
  environmentLabel: string | null;
}) {
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const [link, setLink] = useState<TeamProjectLink | null | "unlinked">(null);
  // Null until the team's Skills folder has been listed.
  const [files, setFiles] = useState<readonly TeamListedDocument[] | null>(null);
  const [authors, setAuthors] = useState<Readonly<Record<string, string>>>();
  const [enabled, setEnabled] = useState<readonly TeamProjectSkill[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // Why the team couldn't be checked; the skills shown are then only the user's own approvals.
  const [problem, setProblem] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const load = useCallback(async () => {
    const current = await run({ action: "skill-enabled", projectId });
    setNotice(null);
    if (!current) return;
    if ("error" in current) {
      // Nothing about this project's skills can be shown as current.
      setEnabled([]);
      setProblem(null);
      setFiles(null);
      if ((current.error as { code?: unknown }).code === "not_found") setLink("unlinked");
      return;
    }
    setEnabled(current.enabledSkills ?? []);
    setProblem(current.problem ?? null);
    if (current.problem) {
      // Only the user's own records are current; an earlier listing of the team isn't.
      setLink(null);
      setFiles(null);
      setAuthors(undefined);
      return;
    }
    setLink(current.projects[0] ?? "unlinked");
    const listed = await run({ action: "skill-list", projectId });
    if (!listed || "error" in listed) return;
    const storage = storageProblem(listed);
    if (storage) return setNotice(storage);
    setAuthors(listed.authors);
    setFiles((listed.storage?.files ?? []).map(({ path, summary }) => ({ path, summary })));
  }, [projectId, run]);
  useEffect(() => {
    void load();
  }, [load]);
  const open = async (path: string, mode: Review["mode"], changed = false) => {
    setNotice(null);
    const result = await run({ action: "skill-read", projectId, path });
    if (!result || "error" in result) return;
    const document = result.storage?.document;
    if (!document || !result.version)
      return setNotice(storageProblem(result) ?? "This skill could not be opened.");
    if (result.authors) setAuthors(result.authors);
    // Text that is no longer the approved version is shown as an update to review.
    const approved = enabled.find((skill) => skill.path === path)?.version;
    const reviewed = mode === "view" && approved !== result.version ? "update" : mode;
    setReview({ document, version: result.version, mode: reviewed, changed });
  };
  const approve = async (current: Review) => {
    const result = await run({
      action: "skill-enable",
      projectId,
      path: current.document.path,
      version: current.version,
    });
    if (!result) return;
    if ("error" in result) {
      // Someone changed it after it was opened: show the current text to review instead.
      if ((result.error as { code?: unknown }).code === "conflict")
        await open(current.document.path, current.mode, true);
      return;
    }
    setReview(null);
    await load();
  };
  const turnOff = async (path: string) => {
    const result = await run({ action: "skill-disable", projectId, path });
    if (!result || "error" in result) return;
    setReview(null);
    await load();
  };
  const turnAllOff = async () => {
    const result = await run({ action: "skill-disable-all", projectId });
    if (!result || "error" in result) return;
    await load();
  };
  if (link === "unlinked")
    return (
      <SettingsRow
        title={`${projectTitle} isn’t linked to a team`}
        description={
          <>
            Link it from{" "}
            <Link to="/teams" className="underline">
              Teams
            </Link>{" "}
            → your team → Team projects to use its team’s skills here.
          </>
        }
      />
    );
  const teamName = link?.teamName ?? "your team";
  const rows = teamProjectSkillRows(files, authors, enabled);
  return (
    <>
      <SettingsRow
        title={`Skills from ${teamName} for ${projectTitle}${environmentLabel ? ` on ${environmentLabel}` : ""}`}
        description={`Turn a skill on to have Harness add it to each message you send in ${projectTitle}. It applies to you and this project only, after you review it, and nothing is installed. If someone edits it, Harness stops adding it until you review the update.`}
      />
      {problem && enabled.length > 0 ? (
        <SettingsRow
          title="Team skills can’t be checked"
          description={
            <span role="alert">
              {problem} Messages in {projectTitle} aren’t sent while these skills are on. Turn them
              off to send without them, or try again.
            </span>
          }
          control={
            <div className="flex items-center gap-2">
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void load()}>
                Retry
              </Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void turnAllOff()}>
                Turn all off
              </Button>
            </div>
          }
        />
      ) : null}
      {error || notice ? (
        <SettingsRow
          title="Team skills problem"
          description={<span role="alert">{error ?? notice}</span>}
          control={
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : null}
      {link === null && !error && !problem ? (
        <SettingsRow title="Team skills" description="Checking your team’s skills…" />
      ) : rows.length === 0 && files !== null && !notice ? (
        <SettingsRow
          title="No team skills yet"
          description={`Editors of ${teamName} can publish one from Teams → ${teamName} → Team projects → Open team skills.`}
        />
      ) : (
        rows.map((row) => {
          const badge = badges[row.state];
          return (
            <SettingsRow
              key={row.path}
              title={
                <span className="inline-flex min-w-0 items-center gap-2">
                  <span className="truncate">{row.label}</span>
                  <Badge size="sm" variant={badge.variant}>
                    {badge.label}
                  </Badge>
                </span>
              }
              description={row.description || undefined}
              status={
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="truncate">
                    {[`${teamName} team skill`, row.source, row.version && `version ${row.version}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {row.reason || row.warning ? (
                    <span className="max-w-xl text-xs text-warning-foreground">
                      {row.reason ?? row.warning}
                    </span>
                  ) : null}
                </div>
              }
              control={
                <div className="flex items-center gap-2">
                  {row.state === "needs-review" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void open(row.path, "update")}
                    >
                      Review update
                    </Button>
                  ) : row.state === "on" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void open(row.path, "view")}
                    >
                      View
                    </Button>
                  ) : null}
                  <Switch
                    checked={row.state !== "off"}
                    aria-label={`${row.label} on for ${projectTitle}`}
                    disabled={busy || (row.state === "off" && row.warning !== null)}
                    onCheckedChange={(checked) =>
                      void (checked ? open(row.path, "enable") : turnOff(row.path))
                    }
                  />
                </div>
              }
            />
          );
        })
      )}
      <SkillReviewDialog
        review={review}
        teamName={teamName}
        projectTitle={projectTitle}
        authors={authors}
        busy={busy}
        onApprove={(current) => void approve(current)}
        onTurnOff={(path) => void turnOff(path)}
        onClose={() => setReview(null)}
      />
    </>
  );
}

/** Shows exactly what Harness will add to each message before a skill or its update is used. */
function SkillReviewDialog({
  review,
  teamName,
  projectTitle,
  authors,
  busy,
  onApprove,
  onTurnOff,
  onClose,
}: {
  review: Review | null;
  teamName: string;
  projectTitle: string;
  authors: Readonly<Record<string, string>> | undefined;
  busy: boolean;
  onApprove: (review: Review) => void;
  onTurnOff: (path: string) => void;
  onClose: () => void;
}) {
  const details = review ? teamNoteHeader(review.document.text) : null;
  const title = details?.title || "Untitled skill";
  return (
    <Dialog open={review !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="max-w-2xl">
        {review && details ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {review.mode === "enable"
                  ? `Turn on “${title}” for ${projectTitle}?`
                  : review.mode === "update"
                    ? `Review the update to “${title}”`
                    : `“${title}” in ${projectTitle}`}
              </DialogTitle>
              <DialogDescription>
                {review.mode === "view"
                  ? `Harness adds exactly this to each message you send in ${projectTitle}.`
                  : `Harness will add exactly this to each message you send in ${projectTitle}, until you turn it off. It applies to you only, and isn’t installed for any agent or other project.`}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="space-y-3">
                {review.changed ? (
                  <p role="status" className="text-sm">
                    This skill changed since you opened it. Review the current text below.
                  </p>
                ) : null}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-border p-3 text-xs">
                  <dt className="text-muted-foreground">Skill</dt>
                  <dd>{title}</dd>
                  <dt className="text-muted-foreground">For</dt>
                  <dd>{details.description || "No description"}</dd>
                  <dt className="text-muted-foreground">Source</dt>
                  <dd>
                    {teamName} shared Skills folder, in{" "}
                    {teamDocumentAuthor(review.document.path, authors)}’s folder
                  </dd>
                  <dt className="text-muted-foreground">Last changed by</dt>
                  <dd>{teamDocumentChange(review.document.lastChange)}</dd>
                  <dt className="text-muted-foreground">Version</dt>
                  <dd>{shortTeamSkillVersion(review.version)}</dd>
                  <dt className="text-muted-foreground">Who can change it</dt>
                  <dd>
                    Every member of {teamName} can read it, and editors can change it. After a
                    change, Harness stops adding it until you review the new version.
                  </dd>
                </dl>
                <pre
                  aria-label="Team skill added to each message"
                  className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap"
                >
                  {formatTeamContext({
                    kind: "skill",
                    teamName,
                    path: review.document.path,
                    text: review.document.text,
                    projectVersion: review.version,
                  })}
                </pre>
                <p className="text-xs text-muted-foreground">
                  The agent may act on these instructions. Your access is checked every time a
                  message is sent, and what was already sent stays in that conversation.
                </p>
              </div>
            </DialogPanel>
            <DialogFooter>
              {review.mode === "enable" ? (
                <Button variant="outline" disabled={busy} onClick={onClose}>
                  Cancel
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => onTurnOff(review.document.path)}
                >
                  Turn off
                </Button>
              )}
              {review.mode === "view" ? (
                <Button disabled={busy} onClick={onClose}>
                  Done
                </Button>
              ) : (
                <Button disabled={busy} onClick={() => onApprove(review)}>
                  {review.mode === "enable" ? `Turn on for ${projectTitle}` : "Use this version"}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
