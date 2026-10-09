import type {
  AccountProfile,
  TeamCommand,
  TeamMember,
  TeamRole,
  TeamsResult,
} from "@t3tools/contracts";

type TeamDetail = NonNullable<TeamsResult["team"]>;
type TeamInvitation = TeamDetail["invitations"][number];

/**
 * A membership change waiting for confirmation. It is bound to the campus account, team revision
 * and target it was opened for, and can only be confirmed while all of them are still current.
 */
export type MembershipReview = {
  readonly account: string;
  readonly teamId: string;
  readonly revision: number;
} & MembershipReviewTarget;

export type MembershipReviewTarget =
  | { readonly kind: "remove"; readonly member: TeamMember }
  | { readonly kind: "role"; readonly member: TeamMember; readonly role: TeamRole }
  | { readonly kind: "leave" }
  | { readonly kind: "cancel-invite"; readonly invitation: TeamInvitation };

export interface MembershipReviewCopy {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly working: string;
  readonly dismiss: string;
  readonly destructive: boolean;
}

export const accountKey = (profile: Pick<AccountProfile, "issuer" | "subject">) =>
  JSON.stringify([profile.issuer, profile.subject]);

/** The service records each member's campus email, and refuses a second member with the same one. */
export const isOwnMember = (member: TeamMember, profile: Pick<AccountProfile, "email">) =>
  member.email.toLowerCase() === profile.email.trim().toLowerCase();

/** Whether a review still targets the signed-in account, the team at the same revision, and a target that still exists unchanged. */
export function isCurrentReview(
  review: MembershipReview | null,
  account: string,
  team: TeamDetail | null | undefined,
): review is MembershipReview {
  if (
    !review ||
    !team ||
    review.account !== account ||
    review.teamId !== team.id ||
    review.revision !== team.revision ||
    team.state !== "ready"
  )
    return false;
  if (review.kind === "leave") return true;
  if (!team.canManage) return false;
  if (review.kind === "cancel-invite")
    return team.invitations.some((entry) => entry.id === review.invitation.id);
  const member = team.members.find((entry) => entry.identityId === review.member.identityId);
  return (
    member !== undefined &&
    member.role === review.member.role &&
    (review.kind === "remove" || review.role !== member.role)
  );
}

export function membershipReviewCommand(review: MembershipReview): TeamCommand {
  const { teamId, revision } = review;
  switch (review.kind) {
    case "remove":
      return { action: "remove-member", teamId, identityId: review.member.identityId, revision };
    case "role":
      return {
        action: "set-role",
        teamId,
        identityId: review.member.identityId,
        role: review.role,
        revision,
      };
    case "leave":
      return { action: "leave", teamId, revision };
    case "cancel-invite":
      return { action: "cancel-invite", teamId, invitationId: review.invitation.id, revision };
  }
}

export const roleLabel = (role: TeamRole) =>
  role === "owner" ? "Owner" : role === "editor" ? "Editor" : "Reader";

const MANAGE = "manage members, invitations, and the team name";
const WRITE = "add and edit team files";
const access = (role: TeamRole) => ({ manage: role === "owner", write: role !== "reader" });

/** Plain, target-specific wording. Access is described as Harness access only. */
export function membershipReviewCopy(
  review: MembershipReview,
  teamName: string,
  self: boolean,
): MembershipReviewCopy {
  const loses = "including its shared storage, team memory, and skills";
  switch (review.kind) {
    case "remove": {
      const { displayName: name, email } = review.member;
      return {
        title: `Remove ${name} from ${teamName}?`,
        description: `${name} (${email}) will lose access to ${teamName} in Harness, ${loses}. Files they added stay with the team. To add them back, invite them again; they'll need to accept.`,
        confirm: "Remove member",
        working: "Removing…",
        dismiss: "Cancel",
        destructive: true,
      };
    }
    case "leave":
      return {
        title: `Leave ${teamName}?`,
        description: `You'll lose access to ${teamName} in Harness, ${loses}. Files you added stay with the team. To rejoin, an owner has to invite you again.`,
        confirm: "Leave team",
        working: "Leaving…",
        dismiss: "Cancel",
        destructive: true,
      };
    case "cancel-invite":
      return {
        title: `Cancel the invitation for ${review.invitation.email}?`,
        description: `The invitation code for ${teamName} will stop working. You can invite them again later.`,
        confirm: "Cancel invitation",
        working: "Cancelling…",
        dismiss: "Keep invitation",
        destructive: true,
      };
    case "role": {
      const before = access(review.member.role);
      const after = access(review.role);
      const lost = [
        before.manage && !after.manage && MANAGE,
        before.write && !after.write && WRITE,
      ];
      const gained = [
        !before.manage && after.manage && MANAGE,
        !before.write && after.write && WRITE,
      ];
      const subject = self ? "You" : review.member.displayName;
      const sentences = [
        lost.some(Boolean) &&
          `${subject} will no longer be able to ${lost.filter(Boolean).join(" or ")}.`,
        gained.some(Boolean) &&
          `${subject} will be able to ${gained.filter(Boolean).join(" and ")}.`,
        !self && after.manage && "Owners can also change your role or remove you.",
        self && before.manage && !after.manage && "Only another owner can make you an owner again.",
      ].filter(Boolean);
      return {
        title: self
          ? `Change your role in ${teamName} to ${roleLabel(review.role)}?`
          : `Change ${review.member.displayName}'s role to ${roleLabel(review.role)}?`,
        description: sentences.join(" "),
        confirm: "Change role",
        working: "Changing role…",
        dismiss: "Cancel",
        destructive: lost.some(Boolean),
      };
    }
  }
}
