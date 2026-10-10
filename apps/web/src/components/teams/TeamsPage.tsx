import { TeamSharedStorage } from "./TeamSharedStorage";
import { StuckProjectLinks, TeamProjects } from "./TeamProjects";
import { HeldTeams, type HeldTeam } from "./TeamAdmin";
// @effect-diagnostics cryptoRandomUUID:off - Browser event creates a retry-stable request ID before dispatch.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AccountProfile,
  EnvironmentId,
  ProjectId,
  TeamCommand,
  TeamRole,
} from "@t3tools/contracts";
import { LockKeyholeIcon, UsersIcon } from "lucide-react";
import { useUcsdAccount } from "../../hooks/useUcsdAccount";
import { useProject } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { isElectron } from "../../env";
import {
  accountKey,
  canTransferOwnership,
  isCurrentReview,
  isOnlyOwner,
  isOwnMember,
  type MembershipReview,
  type MembershipReviewCopy,
  type MembershipReviewTarget,
  membershipReviewCommand,
  membershipReviewCopy,
} from "./teamMembershipReview";
import { useTeamsCommand, useTeamsController } from "./useTeamsController";

export function TeamsPage({
  linkProject,
}: {
  /** Opens on this project's environment with the project chosen in each team's link form. */
  linkProject: { environmentId: EnvironmentId; projectId: ProjectId } | null;
}) {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(
    linkProject?.environmentId ?? null,
  );
  const environmentId = selected ?? primary;
  const linkProjectTitle = useProject(linkProject)?.title ?? null;
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <SidebarTrigger />
        <h1 className="text-sm font-medium">Teams</h1>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Work together, privately</h2>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                Share work summaries, SOPs, and skill documents with the people you invite.
              </p>
            </div>
            {environments.length > 1 ? (
              <label className="text-xs text-muted-foreground">
                Environment
                <select
                  className="mt-1 block rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                  value={environmentId ?? ""}
                  onChange={(event) =>
                    setSelected(
                      environments.find((entry) => entry.environmentId === event.target.value)
                        ?.environmentId ?? null,
                    )
                  }
                >
                  {environments.map((entry) => (
                    <option key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {linkProjectTitle !== null && environmentId === linkProject?.environmentId ? (
            <p className="text-sm text-muted-foreground">
              To link {linkProjectTitle}, open a team below and choose <strong>Link to team</strong>{" "}
              under Team projects.
            </p>
          ) : null}
          {environmentId ? (
            <TeamAccount
              key={environmentId}
              environmentId={environmentId}
              linkProjectId={
                environmentId === linkProject?.environmentId ? linkProject.projectId : null
              }
            />
          ) : (
            <p>Connect to an environment to use Teams.</p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function TeamAccount({
  environmentId,
  linkProjectId,
}: {
  environmentId: EnvironmentId;
  linkProjectId: ProjectId | null;
}) {
  const { account, busy, error, controller } = useUcsdAccount(environmentId);
  const signedIn = account?.status === "signed-in" && account.profile;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
        <div className="flex items-center gap-3">
          <LockKeyholeIcon className="size-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">
              {signedIn ? account.profile!.displayName : "Sign in with UC San Diego"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {signedIn
                ? account.profile!.email
                : "Teams are available to staff in the UCSD pilot."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {signedIn || account?.status === "pending" ? (
            <Button variant="outline" disabled={busy} onClick={() => void controller.signOut()}>
              {signedIn ? "Sign out" : "Cancel sign-in"}
            </Button>
          ) : (
            <Button
              disabled={busy || !account?.configured}
              onClick={() => void controller.signIn()}
            >
              {account ? "Sign in with UC San Diego" : "Checking account…"}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void controller.check()}>
            Refresh account
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {account && !account.configured ? (
        <p className="text-sm text-muted-foreground">
          UC San Diego sign-in is not configured on this environment yet.
        </p>
      ) : null}
      {account?.status === "pending" ? (
        <div role="status" className="rounded-xl border border-border p-4 text-sm">
          Finish signing in in your browser.
          {account.userCode ? (
            <p className="mt-2">
              Confirm this code matches:{" "}
              <strong className="font-mono tracking-widest">{account.userCode}</strong>
            </p>
          ) : null}
          <Button
            className="mt-3"
            variant="outline"
            onClick={() => void controller.reopenBrowser()}
          >
            Reopen browser
          </Button>
        </div>
      ) : null}
      {signedIn ? (
        <TeamWorkspace
          key={`${account.profile!.issuer}:${account.profile!.subject}`}
          environmentId={environmentId}
          profile={account.profile!}
          linkProjectId={linkProjectId}
        />
      ) : null}
    </>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: TeamRole;
  onChange: (role: TeamRole) => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const role = event.target.value;
        if (role === "owner" || role === "editor" || role === "reader") onChange(role);
      }}
    >
      <option value="reader">Reader</option>
      <option value="editor">Editor</option>
      <option value="owner">Owner</option>
    </select>
  );
}

/**
 * Confirms one membership change. Focus starts on the safe choice. After a
 * failed confirm the change may still be in progress, so the only way forward
 * is a refresh, never a retry against the same snapshot.
 */
function MembershipReviewDialog({
  copy,
  busy,
  error,
  onDismiss,
  onConfirm,
  onRefresh,
}: {
  copy: MembershipReviewCopy | null;
  busy: boolean;
  error: string | null;
  onDismiss: () => void;
  onConfirm: () => void;
  onRefresh: (() => void) | null;
}) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  // Keep the last wording on screen while the dialog animates closed.
  const [shown, setShown] = useState(copy);
  if (copy && copy !== shown) setShown(copy);
  return (
    <AlertDialog
      open={copy !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onDismiss();
      }}
    >
      {shown ? (
        <AlertDialogPopup initialFocus={dismissRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{shown.title}</AlertDialogTitle>
            <AlertDialogDescription>{shown.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="px-6 pb-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose
              ref={dismissRef}
              disabled={busy}
              render={<Button variant="outline" />}
            >
              {shown.dismiss}
            </AlertDialogClose>
            {onRefresh ? (
              <Button disabled={busy} onClick={onRefresh}>
                Refresh team
              </Button>
            ) : (
              <Button
                variant={shown.destructive ? "destructive" : "default"}
                disabled={busy}
                onClick={onConfirm}
              >
                {busy ? shown.working : shown.confirm}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogPopup>
      ) : null}
    </AlertDialog>
  );
}

export function TeamWorkspace({
  environmentId,
  profile,
  linkProjectId = null,
}: {
  environmentId: EnvironmentId;
  profile: AccountProfile;
  linkProjectId?: ProjectId | null;
}) {
  const execute = useTeamsCommand(environmentId);
  const controller = useTeamsController(environmentId, profile)!;
  const { result, busy, error } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  useEffect(() => controller.activate(), [controller]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("editor");
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [rename, setRename] = useState("");
  const creation = useRef<{ name: string; requestId: string } | null>(null);
  const team = result?.team;
  const archived = team?.state === "archived";
  // An archived team can't be managed; members can only remove it from their list.
  const owner = team?.canManage === true && !archived;
  const onlyOwner = team ? isOnlyOwner(team, profile) : false;
  const ready = team?.state === "ready" && !busy;
  const run = (command: TeamCommand) => {
    setCopied(null);
    return controller.run(command);
  };
  const account = accountKey(profile);
  // Role picks are staged per team revision; only a confirmed review sends one.
  const draftKey = team ? `${team.id}:${team.revision}` : "";
  const [roleDrafts, setRoleDrafts] = useState<{
    key: string;
    roles: Readonly<Record<string, TeamRole>>;
  }>({ key: "", roles: {} });
  const drafts = roleDrafts.key === draftKey ? roleDrafts.roles : {};
  const stageRole = (identityId: string, value: TeamRole | null) =>
    setRoleDrafts({
      key: draftKey,
      roles: Object.fromEntries(
        Object.entries({ ...drafts, [identityId]: value }).filter(
          (entry): entry is [string, TeamRole] => entry[1] !== null,
        ),
      ),
    });
  const [review, setReview] = useState<MembershipReview | null>(null);
  const [reviewFailed, setReviewFailed] = useState(false);
  const reviewing = isCurrentReview(review, account, team);
  // A review never survives a change of account, team, revision, or target.
  if (review && !reviewing) setReview(null);
  const reviewCopy =
    reviewing && team
      ? membershipReviewCopy(
          review,
          team.name,
          review.kind === "role" && isOwnMember(review.member, profile),
        )
      : null;
  const openReview = (target: MembershipReviewTarget) => {
    if (!team || busy) return;
    setReviewFailed(false);
    setReview({ account, teamId: team.id, revision: team.revision, ...target });
  };
  const dismissReview = () => {
    if (review?.kind === "role") stageRole(review.member.identityId, null);
    setReview(null);
  };
  const confirmReview = () => {
    // Recheck against the controller's latest snapshot, not this render's.
    const latest = controller.getSnapshot();
    if (latest.busy || !isCurrentReview(review, account, latest.result?.team)) return;
    setReviewFailed(false);
    void run(membershipReviewCommand(review)).then((ok) => {
      if (ok) setReview((current) => (current === review ? null : current));
      else setReviewFailed(true);
    });
  };
  const refreshAfterFailure = () => {
    if (!team) return;
    dismissReview();
    void run({ action: "get", teamId: team.id });
  };
  const administrator = result?.administrator === true;
  // Remounting the held-teams list reloads it after a recheck settles.
  const [heldVersion, setHeldVersion] = useState(0);
  const [recheck, setRecheck] = useState<HeldTeam | null>(null);
  const [recheckFailed, setRecheckFailed] = useState(false);
  const openRecheck = (target: HeldTeam) => {
    if (busy) return;
    setRecheckFailed(false);
    setRecheck(target);
  };
  const confirmRecheck = () => {
    if (!recheck || controller.getSnapshot().busy) return;
    setRecheckFailed(false);
    void run({ action: "recheck", teamId: recheck.id, revision: recheck.revision }).then((ok) => {
      if (!ok) {
        setRecheckFailed(true);
        return;
      }
      setRecheck(null);
      setHeldVersion((version) => version + 1);
    });
  };
  // A failed recheck may still be running, so it is never retried against the same revision.
  const refreshAfterRecheck = () => {
    if (!recheck) return;
    const teamId = recheck.id;
    setRecheck(null);
    setHeldVersion((version) => version + 1);
    void run({ action: "get", teamId });
  };
  const recheckCopy: MembershipReviewCopy | null = recheck
    ? {
        title: `Check ${recheck.name} again?`,
        description: `Teams verifies the ${recheck.reference} folder’s SharePoint permissions against the team’s recorded members, and makes the team ready if they match. A join or promotion that didn’t finish isn’t applied: the person accepts again, or an owner repeats the change.`,
        confirm: "Check again",
        working: "Checking…",
        dismiss: "Cancel",
        destructive: false,
      }
    : null;
  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(message);
    } catch {
      setCopied("Copy unavailable. Select and copy the text manually.");
    }
  };
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Your teams</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(team ? { action: "get", teamId: team.id } : { action: "list" })}
        >
          {busy ? "Working…" : "Refresh teams"}
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {result ? (
        <>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const clean = name.trim();
              if (!clean) return;
              if (creation.current?.name !== clean)
                creation.current = { name: clean, requestId: crypto.randomUUID() };
              void run({ action: "create", ...creation.current }).then((ok) => {
                if (ok) {
                  setName("");
                  creation.current = null;
                }
              });
            }}
          >
            <label className="min-w-48 flex-1 text-sm">
              New team name
              <Input
                className="mt-1"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                placeholder="e.g. Finance Operations"
                required
              />
            </label>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create team
            </Button>
          </form>
          {result.teams.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {result.teams.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  disabled={busy}
                  onClick={() => void run({ action: "get", teamId: entry.id })}
                  className={`rounded-xl border p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${team?.id === entry.id ? "border-primary bg-accent/40" : "border-border hover:bg-accent/30"}`}
                >
                  <div className="flex items-center gap-2">
                    <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{entry.name}</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {entry.reference} · {entry.role} ·{" "}
                    {entry.state === "ready"
                      ? "Private folder ready"
                      : entry.state === "provisioning"
                        ? "Setting up"
                        : entry.state === "archived"
                          ? "Archived"
                          : "Needs attention"}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-3 text-sm text-muted-foreground">
              You haven’t joined a team yet. Create one or accept an invitation below.
            </p>
          )}
          {result.invitations.length ? (
            <section className="rounded-xl border border-border p-4">
              <h3 className="font-medium">Pending invitations</h3>
              <ul className="mt-3 space-y-3">
                {result.invitations.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex flex-wrap items-center justify-between gap-3 text-sm"
                  >
                    <div>
                      <p>
                        {invite.teamName}{" "}
                        <span className="text-muted-foreground">· {invite.teamReference}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {invite.role} · Expires{" "}
                        {new Date(invite.expiresAt * 1000).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        disabled={busy}
                        aria-label={`Accept invitation to ${invite.teamName}`}
                        onClick={() =>
                          void run({ action: "accept-pending", invitationId: invite.id })
                        }
                      >
                        Accept
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Decline invitation to ${invite.teamName}`}
                        onClick={() => void run({ action: "decline", invitationId: invite.id })}
                      >
                        Decline
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const match = code.trim().match(/^triton-team:([a-f0-9-]{36}):([A-Za-z0-9_-]{43})$/u);
              if (!match) {
                setCodeError("Paste the complete invitation code from the team owner.");
                return;
              }
              setCodeError(null);
              void run({ action: "accept", invitationId: match[1]!, token: match[2]! }).then(
                (ok) => {
                  if (ok) setCode("");
                },
              );
            }}
          >
            <label className="min-w-48 flex-1 text-sm">
              Accept an invitation
              <Input
                className="mt-1"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                maxLength={160}
                placeholder="triton-team:…"
                required
              />
            </label>
            <Button type="submit" variant="outline" disabled={busy || !code.trim()}>
              Accept invitation
            </Button>
          </form>
          {codeError ? (
            <p role="alert" className="text-sm text-destructive">
              {codeError}
            </p>
          ) : null}
          <StuckProjectLinks
            key={result.teams.map((entry) => `${entry.id}:${entry.state}`).join()}
            environmentId={environmentId}
          />
          {administrator ? (
            <HeldTeams
              key={heldVersion}
              execute={execute}
              disabled={busy}
              onOpen={(teamId) => void run({ action: "get", teamId })}
              onRecheck={openRecheck}
            />
          ) : null}
        </>
      ) : busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading your teams…
        </p>
      ) : null}
      {team ? (
        <section className="space-y-5 rounded-xl border border-border p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">{team.name}</h3>
              <p className="mt-1 select-all font-mono text-xs text-muted-foreground">
                {team.reference}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() =>
                void copy(`${team.name} · ${team.reference} · ${team.id}`, "Team reference copied")
              }
            >
              Copy team reference
            </Button>
          </div>
          {archived ? (
            <p role="status" className="text-sm">
              This team is archived. Its shared storage, team memory, and skills are no longer
              available in Harness, and projects linked to it were unlinked. Its files are kept
              under UC San Diego’s retention policy; ask a system administrator, with the team
              reference above, if you need them.
            </p>
          ) : team.state !== "ready" ? (
            <p role="status" className="text-sm">
              {administrator
                ? "This team’s storage permissions need to be verified before it can be used. Use Check again under Teams needing attention."
                : "This team’s storage permissions need to be verified before it can be used. Give a system administrator the team reference above."}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              The private team folder is ready. Shared files stay with the team when a member
              leaves.
            </p>
          )}
          {team.state === "ready" ? (
            <TeamSharedStorage
              key={`${team.id}:${team.storage?.folderId ?? ""}`}
              environmentId={environmentId}
              teamId={team.id}
              canWrite={team.role !== "reader" || team.canManage}
            />
          ) : null}
          {team.state === "ready" ? (
            <TeamProjects
              key={`${team.id}:${team.storage?.folderId ?? ""}`}
              environmentId={environmentId}
              teamId={team.id}
              linkProjectId={linkProjectId}
              canWrite={team.role !== "reader" || team.canManage}
            />
          ) : null}
          <div>
            <h4 className="text-sm font-medium">Members</h4>
            {owner ? (
              <p className="mt-1 text-xs text-muted-foreground">
                To hand this team to someone else, choose Transfer ownership: they become an owner
                and you become an editor, and only an owner can make you an owner again. A team
                always keeps at least one owner. Pending invitations stay with the team. If an owner
                leaves UC San Diego, another owner can remove them; if they were the only owner,
                give a system administrator the team reference to assign a new one.
              </p>
            ) : null}
            <ul className="mt-2 divide-y divide-border">
              {team.members.map((member) => {
                const self = isOwnMember(member, profile);
                const staged = drafts[member.identityId];
                const name = self ? `${member.displayName} (you)` : member.displayName;
                return (
                  <li
                    key={member.identityId}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm">
                        {member.displayName}
                        {self ? <Badge variant="outline">You</Badge> : null}
                      </p>
                      <p className="break-all text-xs text-muted-foreground">{member.email}</p>
                    </div>
                    {owner ? (
                      <div className="flex items-center gap-2">
                        <RoleSelect
                          label={`Role for ${name}`}
                          value={staged ?? member.role}
                          disabled={!ready}
                          onChange={(value) =>
                            stageRole(member.identityId, value === member.role ? null : value)
                          }
                        />
                        {staged ? (
                          <Button
                            disabled={!ready}
                            aria-label={`Review change for ${name}`}
                            onClick={() => openReview({ kind: "role", member, role: staged })}
                          >
                            Review change
                          </Button>
                        ) : null}
                        {canTransferOwnership(team, member, profile) ? (
                          <Button
                            variant="outline"
                            disabled={!ready}
                            aria-label={`Transfer ownership of ${team.name} to ${member.displayName} (${member.email})`}
                            onClick={() => openReview({ kind: "transfer", member })}
                          >
                            Transfer ownership
                          </Button>
                        ) : null}
                        {self ? null : (
                          <Button
                            variant="ghost"
                            disabled={!ready}
                            aria-label={`Remove ${member.displayName} (${member.email}) from ${team.name}`}
                            onClick={() => openReview({ kind: "remove", member })}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">{member.role}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          {owner ? (
            <>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run({
                    action: "invite",
                    teamId: team.id,
                    email: email.trim(),
                    role,
                    revision: team.revision,
                  }).then((ok) => {
                    if (ok) setEmail("");
                  });
                }}
              >
                <label className="min-w-44 flex-1 text-sm">
                  Invite UCSD staff
                  <Input
                    className="mt-1"
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@ucsd.edu"
                  />
                </label>
                <RoleSelect
                  label="Invitation role"
                  value={role}
                  onChange={setRole}
                  disabled={!ready}
                />
                <Button type="submit" disabled={!ready || !email.trim()}>
                  Create invitation
                </Button>
              </form>
              {result?.invitationCode ? (
                <div className="rounded-lg bg-muted/40 p-3">
                  <p className="text-sm">
                    Send this code to the invited person. Access starts after they sign in and
                    accept it.
                  </p>
                  <p className="my-2 select-all break-all font-mono text-xs">
                    {result.invitationCode}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => void copy(result.invitationCode!, "Invitation code copied")}
                  >
                    Copy invitation code
                  </Button>
                </div>
              ) : null}
              {team.invitations.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="break-all">
                    {invite.email} · {invite.role} · Pending
                  </span>
                  <Button
                    variant="ghost"
                    disabled={!ready}
                    aria-label={`Cancel invitation for ${invite.email}`}
                    onClick={() => openReview({ kind: "cancel-invite", invitation: invite })}
                  >
                    Cancel invitation
                  </Button>
                </div>
              ))}
              <form
                className="flex flex-wrap items-end gap-3 border-t border-border pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run({
                    action: "rename",
                    teamId: team.id,
                    name: rename,
                    revision: team.revision,
                  }).then((ok) => {
                    if (ok) setRename("");
                  });
                }}
              >
                <label className="min-w-44 flex-1 text-sm">
                  Rename team
                  <Input
                    className="mt-1"
                    value={rename}
                    onChange={(event) => setRename(event.target.value)}
                    maxLength={80}
                    placeholder={team.name}
                  />
                </label>
                <Button type="submit" variant="outline" disabled={!ready || !rename.trim()}>
                  Save name
                </Button>
              </form>
            </>
          ) : null}
          {archived ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run({ action: "leave", teamId: team.id, revision: team.revision })
              }
            >
              Remove from your list
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="ghost"
                disabled={!ready || onlyOwner}
                aria-label={`Leave team ${team.name}`}
                onClick={() => openReview({ kind: "leave" })}
              >
                Leave team
              </Button>
              {owner ? (
                <Button
                  variant="destructive-outline"
                  disabled={!ready}
                  aria-label={`Archive team ${team.name}`}
                  onClick={() => openReview({ kind: "archive" })}
                >
                  Archive team
                </Button>
              ) : null}
              {onlyOwner ? (
                <p className="text-xs text-muted-foreground">
                  You’re the only owner. Transfer ownership to another member before you leave, or
                  archive the team.
                </p>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
      <MembershipReviewDialog
        copy={reviewCopy}
        busy={busy}
        error={reviewFailed ? error : null}
        onDismiss={dismissReview}
        onConfirm={confirmReview}
        onRefresh={reviewFailed ? refreshAfterFailure : null}
      />
      <MembershipReviewDialog
        copy={recheckCopy}
        busy={busy}
        error={recheckFailed ? error : null}
        onDismiss={() => setRecheck(null)}
        onConfirm={confirmRecheck}
        onRefresh={recheckFailed ? refreshAfterRecheck : null}
      />
      {copied ? (
        <p role="status" className="text-sm text-muted-foreground">
          {copied}
        </p>
      ) : null}
    </>
  );
}
