import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState, type ReactNode } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { inviteeGate, type InviteeCheck } from "./teamInvitee";

/**
 * Owners check an address before inviting it: Harness looks it up once, shows who it belongs to,
 * and enables the invitation only for that exact address. The lookup guards against typos; the
 * invitee still proves who they are by signing in to accept.
 */
export function TeamInviteForm({
  environmentId,
  account,
  teamId,
  ready,
  invite,
  children,
}: {
  environmentId: EnvironmentId;
  account: string;
  teamId: string;
  ready: boolean;
  invite: (email: string) => Promise<boolean>;
  /** The role picker, shown beside the address. */
  children: ReactNode;
}) {
  const request = useAtomCommand(serverEnvironment.teamStorage, { reportFailure: false });
  const [email, setEmail] = useState("");
  const [check, setCheck] = useState<InviteeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const gate = inviteeGate(check, { account, teamId, email });
  const lookUp = async () => {
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@ucsd\.edu$/u.test(address)) {
      setError("Enter a UCSD address ending in @ucsd.edu.");
      return;
    }
    const id = ++latest.current;
    setChecking(true);
    setError(null);
    try {
      const response = await request({
        environmentId,
        input: { action: "lookup-invitee", teamId, email: address },
      });
      if (id !== latest.current) return;
      if (response._tag !== "Success") throw squashAtomCommandFailure(response);
      const lookup = response.value.invitee;
      if (!lookup) throw new Error("This address couldn't be checked. Try again.");
      setCheck({ account, teamId, lookup });
    } catch (cause) {
      if (id === latest.current)
        setError(cause instanceof Error ? cause.message : "This address couldn't be checked.");
    } finally {
      if (id === latest.current) setChecking(false);
    }
  };
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // A blocked address can be checked again, such as after connecting Microsoft.
          if (gate.kind !== "invite") {
            void lookUp();
            return;
          }
          void invite(email.trim()).then((ok) => {
            if (!ok) return;
            setEmail("");
            setCheck(null);
          });
        }}
      >
        <label className="min-w-44 flex-1 text-sm">
          Invite a UCSD account
          <Input
            className="mt-1"
            type="email"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
            }}
            placeholder="name@ucsd.edu"
          />
        </label>
        {children}
        <Button type="submit" disabled={!ready || checking || !email.trim()}>
          {gate.kind === "invite"
            ? gate.unconfirmed
              ? "Create unconfirmed invitation"
              : "Create invitation"
            : checking
              ? "Checking…"
              : gate.kind === "blocked"
                ? "Check again"
                : "Check address"}
        </Button>
      </form>
      {gate.kind === "invite" && gate.person ? (
        <p role="status" className="text-sm">
          Invitation goes to <strong>{gate.person.displayName}</strong>{" "}
          <span className="break-all text-muted-foreground">
            · {gate.person.userPrincipalName}
            {gate.person.mail &&
            gate.person.mail.toLowerCase() !== gate.person.userPrincipalName.toLowerCase()
              ? ` · ${gate.person.mail}`
              : ""}
          </span>
        </p>
      ) : null}
      {gate.kind !== "check" && gate.message ? (
        <p
          role={gate.kind === "blocked" ? "alert" : "status"}
          className={`text-sm ${gate.kind === "blocked" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {gate.message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
