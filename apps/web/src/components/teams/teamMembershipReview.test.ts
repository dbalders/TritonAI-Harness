import type { TeamsResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountKey,
  canTransferOwnership,
  isCurrentReview,
  isOnlyOwner,
  isOwnMember,
  type MembershipReview,
  membershipReviewCopy,
} from "./teamMembershipReview";

const alice = { identityId: "a".repeat(43), displayName: "Alice", email: "alice@ucsd.edu" };
const carol = { identityId: "c".repeat(43), displayName: "Carol", email: "carol@ucsd.edu" };
const invitation = {
  id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
  teamId: "11111111-2222-4333-8444-555555555555",
  teamName: "Alpha",
  teamReference: "TEAM-ALPHA",
  email: "dan@ucsd.edu",
  role: "reader" as const,
  expiresAt: 4_102_444_800,
};
const team: NonNullable<TeamsResult["team"]> = {
  id: invitation.teamId,
  reference: "TEAM-ALPHA",
  name: "Alpha",
  role: "owner",
  canManage: true,
  state: "ready",
  revision: 3,
  members: [
    { ...alice, role: "owner" },
    { ...carol, role: "editor" },
  ],
  invitations: [invitation],
  storage: null,
};
const account = accountKey({ issuer: "https://campus.example.test", subject: "alice" });
const bound = { account, teamId: team.id, revision: 3 };
const remove: MembershipReview = { ...bound, kind: "remove", member: team.members[1]! };

describe("isCurrentReview", () => {
  it("accepts a review only for the same account, team revision, and unchanged target", () => {
    expect(isCurrentReview(remove, account, team)).toBe(true);
    expect(
      isCurrentReview(
        remove,
        accountKey({ issuer: "https://campus.example.test", subject: "bob" }),
        team,
      ),
    ).toBe(false);
    expect(isCurrentReview(remove, account, { ...team, revision: 4 })).toBe(false);
    expect(isCurrentReview(remove, account, { ...team, state: "provisioning" })).toBe(false);
    expect(isCurrentReview(remove, account, { ...team, canManage: false })).toBe(false);
    expect(isCurrentReview(remove, account, { ...team, members: [team.members[0]!] })).toBe(false);
    expect(isCurrentReview(remove, account, null)).toBe(false);
  });

  it("drops a role review once the member already has that role or a different starting role", () => {
    const role: MembershipReview = {
      ...bound,
      kind: "role",
      member: team.members[1]!,
      role: "reader",
    };
    expect(isCurrentReview(role, account, team)).toBe(true);
    const changed = { ...team, members: [team.members[0]!, { ...carol, role: "reader" as const }] };
    expect(isCurrentReview(role, account, changed)).toBe(false);
  });

  it("keeps Leave available to non-owners and drops a cancelled invitation", () => {
    const leave: MembershipReview = { ...bound, kind: "leave" };
    expect(isCurrentReview(leave, account, { ...team, canManage: false, role: "reader" })).toBe(
      true,
    );
    const cancel: MembershipReview = { ...bound, kind: "cancel-invite", invitation };
    expect(isCurrentReview(cancel, account, team)).toBe(true);
    expect(isCurrentReview(cancel, account, { ...team, invitations: [] })).toBe(false);
  });
});

describe("ownership transfer", () => {
  const me = { email: "alice@ucsd.edu" };
  const transfer: MembershipReview = { ...bound, kind: "transfer", member: team.members[1]! };

  it("is offered by a member owner to a member who isn't an owner", () => {
    expect(canTransferOwnership(team, team.members[1]!, me)).toBe(true);
    expect(canTransferOwnership(team, team.members[0]!, me)).toBe(false);
    // A system administrator outside the team reassigns owners with role changes instead.
    expect(canTransferOwnership(team, team.members[1]!, { email: "admin@ucsd.edu" })).toBe(false);
    const demoted = { ...team, members: [{ ...alice, role: "editor" as const }, team.members[1]!] };
    expect(canTransferOwnership(demoted, team.members[1]!, me)).toBe(false);
  });

  it("drops the review once the target's role changes", () => {
    expect(isCurrentReview(transfer, account, team)).toBe(true);
    const promoted = { ...team, members: [team.members[0]!, { ...carol, role: "owner" as const }] };
    expect(isCurrentReview(transfer, account, promoted)).toBe(false);
  });

  it("knows when you are the only owner", () => {
    expect(isOnlyOwner(team, me)).toBe(true);
    const shared = { ...team, members: [team.members[0]!, { ...carol, role: "owner" as const }] };
    expect(isOnlyOwner(shared, me)).toBe(false);
    expect(isOnlyOwner(team, { email: "carol@ucsd.edu" })).toBe(false);
  });

  it("names the target and says you become an editor", () => {
    const copy = membershipReviewCopy(transfer, "Alpha", false);
    expect(copy.title).toBe("Transfer ownership of Alpha to Carol?");
    expect(copy.description).toContain("Carol (carol@ucsd.edu) will become an owner");
    expect(copy.description).toContain("You'll become an editor");
    expect(copy.description).toContain("pending invitations stay with the team");
    expect(copy.destructive).toBe(true);
  });
});

it("recognizes your row by campus email regardless of case", () => {
  expect(isOwnMember({ ...alice, role: "owner" }, { email: " Alice@UCSD.edu" })).toBe(true);
  expect(isOwnMember({ ...carol, role: "editor" }, { email: "alice@ucsd.edu" })).toBe(false);
});

describe("membershipReviewCopy", () => {
  it("warns about losing ownership only when you lower your own role", () => {
    const self = membershipReviewCopy(
      { ...bound, kind: "role", member: team.members[0]!, role: "editor" },
      "Alpha",
      true,
    );
    expect(self.description).toContain("Only another owner can make you an owner again.");
    expect(self.destructive).toBe(true);
    const promotion = membershipReviewCopy(
      { ...bound, kind: "role", member: team.members[1]!, role: "owner" },
      "Alpha",
      false,
    );
    expect(promotion.destructive).toBe(false);
    expect(promotion.description).toContain("Carol will be able to manage members");
    expect(promotion.description).toContain("Owners can also change your role or remove you.");
  });

  it("tells an owner that a removed or demoted owner's invitations stay valid", () => {
    const owner = { ...carol, role: "owner" as const };
    expect(
      membershipReviewCopy({ ...bound, kind: "remove", member: owner }, "Alpha", false).description,
    ).toContain("Pending invitations they created stay valid");
    expect(
      membershipReviewCopy(
        { ...bound, kind: "role", member: owner, role: "editor" },
        "Alpha",
        false,
      ).description,
    ).toContain("Pending invitations they created stay valid");
    expect(membershipReviewCopy(remove, "Alpha", false).description).not.toContain("invitations");
  });

  it("describes removal as Harness access, not storage permission changes", () => {
    const copy = membershipReviewCopy(remove, "Alpha", false);
    expect(copy.description).toContain("lose access to Alpha in Harness");
    expect(copy.description).not.toMatch(/SharePoint|permission/iu);
  });
});
