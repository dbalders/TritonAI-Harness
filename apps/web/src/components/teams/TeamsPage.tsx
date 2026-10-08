import { TeamSharedStorage } from "./TeamSharedStorage";
// @effect-diagnostics cryptoRandomUUID:off - Browser event creates a retry-stable request ID before dispatch.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createTeamsController } from "@t3tools/client-runtime/state/server";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TeamCommand, TeamRole } from "@t3tools/contracts";
import { LockKeyholeIcon, UsersIcon } from "lucide-react";
import { useUcsdAccount } from "../../hooks/useUcsdAccount";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { isElectron } from "../../env";

export function TeamsPage() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId = selected ?? primary;
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
          {environmentId ? (
            <TeamAccount key={environmentId} environmentId={environmentId} />
          ) : (
            <p>Connect to an environment to use Teams.</p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function TeamAccount({ environmentId }: { environmentId: EnvironmentId }) {
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

function TeamWorkspace({ environmentId }: { environmentId: EnvironmentId }) {
  const request = useAtomCommand(serverEnvironment.teams, { reportFailure: false });
  const controller = useMemo(
    () =>
      createTeamsController(async (input) => {
        const response = await request({ environmentId, input });
        if (response._tag === "Success") return response.value;
        const error = squashAtomCommandFailure(response);
        throw error instanceof Error ? error : new Error("Teams could not be reached.");
      }),
    [environmentId, request],
  );
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
  const owner = team?.canManage === true;
  const ready = team?.state === "ready" && !busy;
  const run = (command: TeamCommand) => {
    setCopied(null);
    return controller.run(command);
  };
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
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void run({ action: "decline", invitationId: invite.id })}
                    >
                      Decline
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                Paste the invitation code from the team owner to accept.
              </p>
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
          {team.state !== "ready" ? (
            <p role="status" className="text-sm">
              This team’s storage permissions need to be verified before it can be used. Give a
              system administrator the team reference above.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              The private team folder is ready. Shared files stay with the team when a member
              leaves.
            </p>
          )}
          {team.state === "ready" ? (
            <TeamSharedStorage
              key={`${team.id}:${team.revision}`}
              environmentId={environmentId}
              teamId={team.id}
              canWrite={team.role !== "reader" || team.canManage}
            />
          ) : null}
          <div>
            <h4 className="text-sm font-medium">Members</h4>
            <ul className="mt-2 divide-y divide-border">
              {team.members.map((member) => (
                <li
                  key={member.identityId}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm">{member.displayName}</p>
                    <p className="break-all text-xs text-muted-foreground">{member.email}</p>
                  </div>
                  {owner ? (
                    <div className="flex items-center gap-2">
                      <RoleSelect
                        label={`Role for ${member.displayName}`}
                        value={member.role}
                        disabled={!ready}
                        onChange={(value) =>
                          void run({
                            action: "set-role",
                            teamId: team.id,
                            identityId: member.identityId,
                            role: value,
                            revision: team.revision,
                          })
                        }
                      />
                      <Button
                        variant="ghost"
                        disabled={!ready}
                        onClick={() =>
                          void run({
                            action: "remove-member",
                            teamId: team.id,
                            identityId: member.identityId,
                            revision: team.revision,
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">{member.role}</span>
                  )}
                </li>
              ))}
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
                    onClick={() =>
                      void run({
                        action: "cancel-invite",
                        teamId: team.id,
                        invitationId: invite.id,
                        revision: team.revision,
                      })
                    }
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
          <Button
            variant="ghost"
            disabled={!ready}
            onClick={() => void run({ action: "leave", teamId: team.id, revision: team.revision })}
          >
            Leave team
          </Button>
        </section>
      ) : null}
      {copied ? (
        <p role="status" className="text-sm text-muted-foreground">
          {copied}
        </p>
      ) : null}
    </>
  );
}
