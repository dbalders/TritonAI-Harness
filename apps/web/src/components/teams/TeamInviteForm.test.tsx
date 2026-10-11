// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, type TeamStorageCommand, type TeamStorageStatus } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  calls: [] as TeamStorageCommand[],
  invitee: null as TeamStorageStatus["invitee"] | null,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({ input }: { input: TeamStorageCommand }) => {
      mocks.calls.push(input);
      const email = input.action === "lookup-invitee" ? input.email : "";
      return {
        _tag: "Success",
        value: { status: "connected", invitee: { ...mocks.invitee, email } },
      };
    },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { teamStorage: "teamStorage" } }));

import { TeamInviteForm } from "./TeamInviteForm";

let root: Root;
let container: HTMLDivElement;
const invites: string[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.calls = [];
  invites.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () =>
  act(async () =>
    root.render(
      <TeamInviteForm
        environmentId={EnvironmentId.make("env")}
        account="campus:alice"
        teamId="team-a"
        ready
        invite={async (email) => {
          invites.push(email);
          return true;
        }}
      >
        {null}
      </TeamInviteForm>,
    ),
  );
const input = () => container.querySelector("input")!;
const button = () => container.querySelector<HTMLButtonElement>("button[type=submit]")!;
const type = (value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = () => act(async () => button().click());

it("shows who an address belongs to before inviting, and rechecks after an edit", async () => {
  mocks.invitee = {
    email: "",
    status: "found",
    displayName: "Bob Example",
    userPrincipalName: "bob@ucsd.edu",
    mail: null,
  };
  await render();
  await type("Bob@ucsd.edu");
  expect(button().textContent).toBe("Check address");
  await submit();
  expect(mocks.calls).toEqual([
    { action: "lookup-invitee", teamId: "team-a", email: "bob@ucsd.edu" },
  ]);
  expect(container.textContent).toContain("Invitation goes to Bob Example");
  expect(button().textContent).toBe("Create invitation");
  await type("Bobb@ucsd.edu");
  expect(container.textContent).not.toContain("Bob Example");
  expect(button().textContent).toBe("Check address");
  expect(invites).toEqual([]);
  await submit();
  await submit();
  expect(invites).toEqual(["Bobb@ucsd.edu"]);
  expect(mocks.calls).toHaveLength(2);
});

it("sends an unconfirmed invitation only after saying lookup is off", async () => {
  mocks.invitee = { email: "", status: "off" };
  await render();
  await type("bob@ucsd.edu");
  await submit();
  expect(container.textContent).toContain("hasn't confirmed who uses bob@ucsd.edu");
  expect(button().textContent).toBe("Create unconfirmed invitation");
  await submit();
  expect(invites).toEqual(["bob@ucsd.edu"]);
});

it("refuses a guest account and never invites it", async () => {
  mocks.invitee = { email: "", status: "guest" };
  await render();
  await type("bob@ucsd.edu");
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("guest account");
  await submit();
  expect(invites).toEqual([]);
  expect(mocks.calls).toHaveLength(2);
});
