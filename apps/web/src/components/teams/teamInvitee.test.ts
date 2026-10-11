import type { TeamInviteeLookup } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { inviteeGate } from "./teamInvitee";

const found: TeamInviteeLookup = {
  email: "bob@ucsd.edu",
  status: "found",
  displayName: "Bob Example",
  userPrincipalName: "bob@ucsd.edu",
  mail: "bob@ucsd.edu",
};
const current = { account: "campus:alice", teamId: "team-a", email: " Bob@UCSD.edu " };
const check = (lookup: TeamInviteeLookup = found) => ({
  account: "campus:alice",
  teamId: "team-a",
  lookup,
});

it("enables an invitation only for the exact address, account, and team that were looked up", () => {
  expect(inviteeGate(null, current).kind).toBe("check");
  expect(inviteeGate(check(), current)).toMatchObject({
    kind: "invite",
    unconfirmed: false,
    person: { displayName: "Bob Example" },
  });
  expect(inviteeGate(check(), { ...current, email: "bobb@ucsd.edu" }).kind).toBe("check");
  expect(inviteeGate(check(), { ...current, account: "campus:mallory" }).kind).toBe("check");
  expect(inviteeGate(check(), { ...current, teamId: "team-b" }).kind).toBe("check");
});

it("keeps the unconfirmed path honest when lookup is off", () => {
  const gate = inviteeGate(check({ email: "bob@ucsd.edu", status: "off" }), current);
  expect(gate).toMatchObject({ kind: "invite", unconfirmed: true, person: null });
  expect(gate.kind === "invite" && gate.message).toContain(
    "hasn't confirmed who uses bob@ucsd.edu",
  );
});

it("blocks addresses the directory couldn't resolve to one member account", () => {
  for (const status of [
    "connect",
    "mismatch",
    "not-found",
    "ambiguous",
    "guest",
    "not-permitted",
  ] as const)
    expect(inviteeGate(check({ email: "bob@ucsd.edu", status }), current).kind).toBe("blocked");
});
