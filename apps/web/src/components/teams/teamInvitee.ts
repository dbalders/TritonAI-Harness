import type { TeamInviteeLookup } from "@t3tools/contracts";

/** A lookup result and the account and team it was made for. */
export interface InviteeCheck {
  readonly account: string;
  readonly teamId: string;
  readonly lookup: TeamInviteeLookup;
}

export type InviteeGate =
  /** The typed address hasn't been looked up for this account and team. */
  | { readonly kind: "check" }
  | {
      readonly kind: "invite";
      /** True when Harness couldn't look the address up, so nobody was confirmed. */
      readonly unconfirmed: boolean;
      readonly person: Extract<TeamInviteeLookup, { status: "found" }> | null;
      readonly message: string | null;
    }
  | { readonly kind: "blocked"; readonly message: string };

/**
 * Whether the typed address can be invited. A check counts only for the exact address, account,
 * and team it was made for, so editing the address or switching either needs a new lookup.
 */
export function inviteeGate(
  check: InviteeCheck | null,
  current: { account: string; teamId: string; email: string },
): InviteeGate {
  const email = current.email.trim().toLowerCase();
  if (
    !check ||
    check.account !== current.account ||
    check.teamId !== current.teamId ||
    check.lookup.email !== email
  )
    return { kind: "check" };
  const lookup = check.lookup;
  switch (lookup.status) {
    case "found":
      return { kind: "invite", unconfirmed: false, person: lookup, message: null };
    case "off":
      return {
        kind: "invite",
        unconfirmed: true,
        person: null,
        message: `Harness can't look up UCSD accounts here yet, so it hasn't confirmed who uses ${email}. Check the spelling: whoever signs in as this address can accept.`,
      };
    case "connect":
      return {
        kind: "blocked",
        message: "Connect Microsoft under Shared storage, then check the address again.",
      };
    case "not-found":
      return { kind: "blocked", message: `No UCSD account uses ${email}. Check the spelling.` };
    case "ambiguous":
      return {
        kind: "blocked",
        message: `More than one UCSD account matches ${email}. Ask the person for the address they sign in with.`,
      };
    case "guest":
      return {
        kind: "blocked",
        message: `${email} belongs to a guest account. Teams invitations need a UCSD member account.`,
      };
    case "not-permitted":
      return {
        kind: "blocked",
        message:
          "Microsoft didn't let Harness look up UCSD accounts. Disconnect and reconnect Microsoft under Shared storage to approve it, or ask your administrator.",
      };
  }
}
