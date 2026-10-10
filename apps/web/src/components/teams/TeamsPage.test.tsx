// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  type TeamCommand,
  TeamsError,
  type TeamsResult,
  type TeamRole,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Reply = TeamsResult | TeamsError | Promise<TeamsResult | TeamsError>;
const mocks = vi.hoisted(() => ({
  calls: [] as TeamCommand[],
  reply: (_command: TeamCommand): Reply => {
    throw new Error("No reply configured");
  },
}));
vi.mock("../../state/use-atom-command", () => {
  const isTeamsError = Schema.is(TeamsError);
  const request = async ({ input }: { input: TeamCommand }) => {
    mocks.calls.push(input);
    const value = await mocks.reply(input);
    return isTeamsError(value)
      ? { _tag: "Failure", cause: Cause.fail(value) }
      : { _tag: "Success", value };
  };
  return { useAtomCommand: () => request };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { teams: "teams" } }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../hooks/useUcsdAccount", () => ({ useUcsdAccount: vi.fn() }));
vi.mock("./TeamSharedStorage", () => ({ TeamSharedStorage: () => null }));
vi.mock("./TeamProjects", () => ({ TeamProjects: () => null, StuckProjectLinks: () => null }));

import { TeamWorkspace } from "./TeamsPage";

const TEAM_ID = "11111111-2222-4333-8444-555555555555";
const INVITE_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const id = (letter: string) => letter.repeat(43);
const profile = {
  issuer: "https://campus.example.test",
  subject: "alice",
  email: "Alice@ucsd.edu",
  displayName: "Alice",
};
const member = (name: string, letter: string, role: TeamRole) => ({
  identityId: id(letter),
  displayName: name,
  email: `${name.toLowerCase()}@ucsd.edu`,
  role,
});
const teamResult = (
  revision: number,
  members = [
    member("Alice", "a", "owner"),
    member("Bob", "b", "owner"),
    member("Carol", "c", "editor"),
  ],
): TeamsResult => {
  const summary = {
    id: TEAM_ID,
    reference: "TEAM-ALPHA",
    name: "Alpha",
    role: "owner" as const,
    canManage: true,
    state: "ready" as const,
    revision,
  };
  return {
    teams: [summary],
    invitations: [],
    team: {
      ...summary,
      members,
      invitations: [
        {
          id: INVITE_ID,
          teamId: TEAM_ID,
          teamName: "Alpha",
          teamReference: "TEAM-ALPHA",
          email: "dan@ucsd.edu",
          role: "reader",
          expiresAt: 4_102_444_800,
        },
      ],
      storage: null,
    },
    invitationCode: null,
  };
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Base UI moves focus and unmounts closed popups on the next frame.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.calls = [];
  mocks.reply = () => teamResult(3);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderWorkspace() {
  await act(async () =>
    root.render(<TeamWorkspace environmentId={EnvironmentId.make("env")} profile={profile} />),
  );
  expect(mocks.calls).toEqual([{ action: "list" }]);
  mocks.calls = [];
}
const byLabel = (label: string) => {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing ${label}`);
  return element;
};
const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
/** A button inside the open review, never the page action that opened it. */
const buttonNamed = (text: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (entry) => entry.textContent?.trim() === text,
  );
const press = (element: HTMLElement | undefined) => act(async () => element!.click());

it("marks your own row, gives each action its target, and routes your removal through Leave", async () => {
  await renderWorkspace();
  const ownRow = byLabel("Role for Alice (you)").closest("li")!;
  expect(ownRow.textContent).toContain("You");
  expect(ownRow.querySelector('[aria-label^="Remove"]')).toBeNull();
  expect(byLabel("Remove Bob (bob@ucsd.edu) from Alpha").textContent).toBe("Remove");
  expect(byLabel("Remove Carol (carol@ucsd.edu) from Alpha").textContent).toBe("Remove");
  expect(byLabel("Cancel invitation for dan@ucsd.edu").textContent).toBe("Cancel invitation");
  expect(byLabel("Leave team Alpha").textContent).toBe("Leave team");
});

it("removes a member only after confirmation, with the reviewed revision and target, once", async () => {
  await renderWorkspace();
  await press(byLabel("Remove Carol (carol@ucsd.edu) from Alpha"));
  expect(mocks.calls).toEqual([]);
  expect(dialog()?.textContent).toContain("Remove Carol from Alpha?");
  expect(dialog()?.textContent).toContain("carol@ucsd.edu");
  expect(dialog()?.textContent).toContain("invite them again");
  expect(document.activeElement?.textContent).toBe("Cancel");

  await press(buttonNamed("Cancel"));
  expect(dialog()).toBeNull();
  expect(mocks.calls).toEqual([]);

  let finish: (value: TeamsResult) => void = () => {};
  mocks.reply = () => new Promise((resolve) => (finish = resolve));
  await press(byLabel("Remove Carol (carol@ucsd.edu) from Alpha"));
  await press(buttonNamed("Remove member"));
  const working = buttonNamed("Removing…")!;
  expect(working.disabled).toBe(true);
  await press(working);
  expect(mocks.calls).toEqual([
    { action: "remove-member", teamId: TEAM_ID, identityId: id("c"), revision: 3 },
  ]);
  await act(async () =>
    finish(teamResult(4, [member("Alice", "a", "owner"), member("Bob", "b", "owner")])),
  );
  expect(dialog()).toBeNull();
  expect(document.querySelector('[aria-label^="Remove Carol"]')).toBeNull();
});

it("stages a role choice and sends it only from the confirmed review", async () => {
  await renderWorkspace();
  const select = byLabel("Role for Carol") as HTMLSelectElement;
  await act(async () => {
    select.value = "reader";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mocks.calls).toEqual([]);
  expect(select.value).toBe("reader");

  await press(byLabel("Review change for Carol"));
  expect(dialog()?.textContent).toContain("Change Carol's role to Reader?");
  expect(dialog()?.textContent).toContain(
    "Carol will no longer be able to add and edit team files.",
  );
  await press(buttonNamed("Cancel"));
  expect(mocks.calls).toEqual([]);
  expect((byLabel("Role for Carol") as HTMLSelectElement).value).toBe("editor");

  await act(async () => {
    select.value = "reader";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  mocks.reply = () => teamResult(4);
  await press(byLabel("Review change for Carol"));
  await press(buttonNamed("Change role"));
  expect(mocks.calls).toEqual([
    { action: "set-role", teamId: TEAM_ID, identityId: id("c"), role: "reader", revision: 3 },
  ]);
  expect(dialog()).toBeNull();
});

it("warns before you lower your own role and keeps the review open on a refusal", async () => {
  await renderWorkspace();
  const select = byLabel("Role for Alice (you)") as HTMLSelectElement;
  await act(async () => {
    select.value = "editor";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await press(byLabel("Review change for Alice (you)"));
  expect(dialog()?.textContent).toContain("Change your role in Alpha to Editor?");
  expect(dialog()?.textContent).toContain("Only another owner can make you an owner again.");

  mocks.reply = () =>
    new TeamsError({ code: "conflict", message: "Assign another owner before changing roles." });
  await press(buttonNamed("Change role"));
  expect(mocks.calls).toEqual([
    { action: "set-role", teamId: TEAM_ID, identityId: id("a"), role: "editor", revision: 3 },
  ]);
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
    "Assign another owner before changing roles.",
  );
  expect(buttonNamed("Change role")).toBeUndefined();
  expect(buttonNamed("Refresh team")?.disabled).toBe(false);
});

it("leaves only after confirmation and offers a refresh, not a retry, after a transient failure", async () => {
  await renderWorkspace();
  await press(byLabel("Leave team Alpha"));
  expect(mocks.calls).toEqual([]);
  expect(dialog()?.textContent).toContain("Leave Alpha?");
  expect(dialog()?.textContent).toContain("an owner has to invite you again");

  mocks.reply = () =>
    new TeamsError({ code: "unavailable", message: "Teams did not confirm this change." });
  await press(buttonNamed("Leave team"));
  expect(dialog()?.textContent).toContain("Teams did not confirm this change.");
  // The leave may still be in progress, so the dialog can't send it again.
  expect(buttonNamed("Leave team")).toBeUndefined();
  expect(buttonNamed("Refresh team")?.disabled).toBe(false);

  mocks.reply = () => ({ ...teamResult(4), teams: [], team: null });
  await press(buttonNamed("Refresh team"));
  expect(mocks.calls).toEqual([
    { action: "leave", teamId: TEAM_ID, revision: 3 },
    { action: "get", teamId: TEAM_ID },
  ]);
  expect(dialog()).toBeNull();
});

it("transfers ownership to a named member in one confirmed change", async () => {
  await renderWorkspace();
  // Only members who aren't owners yet can receive ownership.
  expect(document.querySelector('[aria-label^="Transfer ownership of Alpha to Bob"]')).toBeNull();
  expect(document.querySelector('[aria-label^="Transfer ownership of Alpha to Alice"]')).toBeNull();
  await press(byLabel("Transfer ownership of Alpha to Carol (carol@ucsd.edu)"));
  expect(mocks.calls).toEqual([]);
  expect(dialog()?.textContent).toContain("Transfer ownership of Alpha to Carol?");
  expect(dialog()?.textContent).toContain("carol@ucsd.edu");
  expect(dialog()?.textContent).toContain("You'll become an editor");
  expect(dialog()?.textContent).toContain("only an owner can make you an owner again");
  expect(document.activeElement?.textContent).toBe("Cancel");

  mocks.reply = () => ({
    ...teamResult(4, [
      member("Alice", "a", "editor"),
      member("Bob", "b", "owner"),
      member("Carol", "c", "owner"),
    ]),
  });
  await press(buttonNamed("Transfer ownership"));
  expect(mocks.calls).toEqual([
    { action: "transfer-ownership", teamId: TEAM_ID, identityId: id("c"), revision: 3 },
  ]);
  expect(dialog()).toBeNull();
});

it("asks the only owner to transfer ownership before leaving", async () => {
  mocks.reply = () =>
    teamResult(3, [member("Alice", "a", "owner"), member("Carol", "c", "editor")]);
  await renderWorkspace();
  const leave = byLabel("Leave team Alpha") as HTMLButtonElement;
  expect(leave.disabled).toBe(true);
  expect(leave.parentElement?.textContent).toContain(
    "Transfer ownership to another member before you leave.",
  );
  expect(byLabel("Transfer ownership of Alpha to Carol (carol@ucsd.edu)")).not.toBeNull();
});

it("cancels an invitation only after confirmation", async () => {
  await renderWorkspace();
  await press(byLabel("Cancel invitation for dan@ucsd.edu"));
  expect(dialog()?.textContent).toContain("Cancel the invitation for dan@ucsd.edu?");
  await press(buttonNamed("Keep invitation"));
  expect(dialog()).toBeNull();
  expect(mocks.calls).toEqual([]);

  await press(byLabel("Cancel invitation for dan@ucsd.edu"));
  await press(buttonNamed("Cancel invitation"));
  expect(mocks.calls).toEqual([
    { action: "cancel-invite", teamId: TEAM_ID, invitationId: INVITE_ID, revision: 3 },
  ]);
});

it("closes a review when the team changes underneath it, so it can't be confirmed", async () => {
  await renderWorkspace();
  await press(byLabel("Remove Carol (carol@ucsd.edu) from Alpha"));
  expect(dialog()).not.toBeNull();
  // Another owner's change arrives through a refresh while the review is open.
  mocks.reply = () => teamResult(4);
  const refresh = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Refresh teams",
  );
  await press(refresh);
  expect(dialog()).toBeNull();
  expect(mocks.calls).toEqual([{ action: "get", teamId: TEAM_ID }]);
});

it("clears the review when access is refused", async () => {
  await renderWorkspace();
  await press(byLabel("Remove Bob (bob@ucsd.edu) from Alpha"));
  mocks.reply = () =>
    new TeamsError({ code: "forbidden", message: "Only team owners can do this." });
  await press(buttonNamed("Remove member"));
  expect(dialog()).toBeNull();
  expect(document.querySelector('[aria-label^="Remove"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Only team owners can do this.",
  );
});

const heldTeam = {
  id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
  reference: "TEAM-HELD",
  name: "Held",
  role: "owner" as const,
  canManage: true,
  state: "needs-attention" as const,
  revision: 7,
};
const pageButton = (text: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);

it("shows held teams only to administrators", async () => {
  await renderWorkspace();
  expect(container.textContent).not.toContain("Teams needing attention");
  expect(mocks.calls).toEqual([]);
});

it("rechecks a held team only after confirmation, at its listed revision", async () => {
  mocks.reply = (command) =>
    command.action === "admin-list"
      ? { ...teamResult(3), teams: [heldTeam], team: null }
      : { ...teamResult(3), administrator: true };
  await act(async () =>
    root.render(<TeamWorkspace environmentId={EnvironmentId.make("env")} profile={profile} />),
  );
  expect(mocks.calls).toEqual([{ action: "list" }, { action: "admin-list" }]);
  expect(container.textContent).toContain("TEAM-HELD · Needs attention");
  mocks.calls = [];

  await press(byLabel("Check Held again"));
  expect(mocks.calls).toEqual([]);
  expect(dialog()?.textContent).toContain("Check Held again?");
  expect(dialog()?.textContent).toContain("isn’t applied");
  await press(buttonNamed("Cancel"));
  expect(mocks.calls).toEqual([]);

  await press(byLabel("Check Held again"));
  await press(buttonNamed("Check again"));
  // The list reloads once the team is ready.
  expect(mocks.calls).toEqual([
    { action: "recheck", teamId: heldTeam.id, revision: 7 },
    { action: "admin-list" },
  ]);
  expect(dialog()).toBeNull();
});

it("offers a refresh, not a second check, when a recheck isn't confirmed", async () => {
  mocks.reply = (command) =>
    command.action === "admin-list"
      ? { ...teamResult(3), teams: [heldTeam], team: null }
      : command.action === "recheck"
        ? new TeamsError({ code: "unavailable", message: "Teams did not confirm this change." })
        : { ...teamResult(3), administrator: true };
  await act(async () =>
    root.render(<TeamWorkspace environmentId={EnvironmentId.make("env")} profile={profile} />),
  );
  mocks.calls = [];
  await press(byLabel("Check Held again"));
  await press(buttonNamed("Check again"));
  expect(dialog()?.textContent).toContain("Teams did not confirm this change.");
  expect(buttonNamed("Check again")).toBeUndefined();
  await press(buttonNamed("Refresh team"));
  expect(dialog()).toBeNull();
  expect(mocks.calls).toEqual([
    { action: "recheck", teamId: heldTeam.id, revision: 7 },
    { action: "get", teamId: heldTeam.id },
    { action: "admin-list" },
  ]);
  expect(pageButton("Refresh list")).toBeDefined();
});
