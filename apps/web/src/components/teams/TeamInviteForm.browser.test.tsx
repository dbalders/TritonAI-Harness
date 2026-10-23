import { act, render as renderComponent, type Screen } from "../../../test/render";
import { EnvironmentId, type TeamStorageCommand, type TeamStorageStatus } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  calls: [] as TeamStorageCommand[],
  invitee: null as TeamStorageStatus["invitee"] | null,
  failure: null as string | null,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    () =>
    async ({ input }: { input: TeamStorageCommand }) => {
      mocks.calls.push(input);
      if (mocks.failure !== null) throw new Error(mocks.failure);
      const email = input.action === "lookup-invitee" ? input.email : "";
      return {
        _tag: "Success",
        value: { status: "connected", invitee: { ...mocks.invitee, email } },
      };
    },
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { teamStorage: "teamStorage" } }));

import { TeamInviteForm } from "./TeamInviteForm";

let view: Screen | null = null;
let container: HTMLElement;
const invites: string[] = [];
async function mount(ui: import("react").ReactNode) {
  if (view) await view.rerender(ui);
  else view = await renderComponent(ui, { router: false });
  container = view.container;
  return view;
}

function setup() {
  view = null;
  mocks.calls = [];
  mocks.failure = null;
  invites.length = 0;
}

const renderView = () =>
  mount(
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
  setup();
  mocks.invitee = {
    email: "",
    status: "found",
    displayName: "Bob Example",
    userPrincipalName: "bob@ucsd.edu",
    mail: null,
  };
  await using _screen = await renderView();
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
  setup();
  mocks.invitee = { email: "", status: "off" };
  await using _screen = await renderView();
  await type("bob@ucsd.edu");
  await submit();
  expect(container.textContent).toContain("hasn't confirmed who uses bob@ucsd.edu");
  expect(button().textContent).toBe("Create unconfirmed invitation");
  await submit();
  expect(invites).toEqual(["bob@ucsd.edu"]);
});

it("refuses a guest account and never invites it", async () => {
  setup();
  mocks.invitee = { email: "", status: "guest" };
  await using _screen = await renderView();
  await type("bob@ucsd.edu");
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("guest account");
  await submit();
  expect(invites).toEqual([]);
  expect(mocks.calls).toHaveLength(2);
});

it("recovers from a failed address check before allowing an invitation", async () => {
  setup();
  mocks.invitee = {
    email: "",
    status: "found",
    displayName: "Bob Example",
    userPrincipalName: "bob@ucsd.edu",
    mail: null,
  };
  mocks.failure = "Address lookup is temporarily unavailable.";
  await using _screen = await renderView();
  await type("bob@ucsd.edu");
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(mocks.failure);
  expect(button().textContent).toBe("Check address");
  expect(button().disabled).toBe(false);
  expect(invites).toEqual([]);

  mocks.failure = null;
  await submit();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button().textContent).toBe("Create invitation");
  await submit();
  expect(invites).toEqual(["bob@ucsd.edu"]);
  expect(mocks.calls).toHaveLength(2);
});
