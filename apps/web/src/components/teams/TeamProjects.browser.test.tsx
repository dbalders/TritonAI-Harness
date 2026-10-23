import { act, render as renderComponent, type Screen } from "../../../test/render";
import { useState } from "react";
import { EnvironmentId, type TeamProjectCommand } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ calls: [] as TeamProjectCommand[] }));
vi.mock("../../state/use-atom-command", () => {
  const request = async ({ input }: { input: TeamProjectCommand }) => {
    mocks.calls.push(input);
    return {
      _tag: "Success",
      value: {
        projects: [{ projectId: "p-1", projectTitle: "Linked", sharingSince: "2026-10-01" }],
      },
    };
  };
  return { useAtomCommand: () => request };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { teamProjects: "teamProjects" } }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "p-2", environmentId: "env", title: "Grant reports" },
    { id: "p-3", environmentId: "env", title: "Office procedures" },
  ],
}));
vi.mock("./TeamDocuments", () => ({ TeamDocuments: () => null }));

import { TeamProjects } from "./TeamProjects";

let view: Screen | null = null;
let container: HTMLElement;

async function mount(ui: import("react").ReactNode) {
  if (view) await view.rerender(ui);
  else view = await renderComponent(ui, { router: false });
  container = view.container;
  return view;
}

function setup() {
  view = null;
  mocks.calls = [];
}

/** A parent that refreshes its own state whenever links are reported, as the Teams page does. */
function Parent() {
  const [notices, setNotices] = useState(0);
  return (
    <div data-notices={notices}>
      <TeamProjects
        environmentId={EnvironmentId.make("env")}
        teamId="team"
        linkProjectId={null}
        canWrite
        onLinksChange={() => setNotices((count) => count + 1)}
      />
    </div>
  );
}

it("loads a team's projects once, however the parent reacts to the links it reports", async () => {
  setup();
  await using _screen = await mount(<Parent />);
  for (let settle = 0; settle < 5; settle++) await act(async () => {});
  expect(mocks.calls).toEqual([{ action: "list", teamId: "team" }]);
  expect(container.querySelector("[data-notices]")?.getAttribute("data-notices")).toBe("1");
  expect(container.textContent).toContain("Linked");
});

it("requires acknowledgement of automatic sharing before linking a project", async () => {
  setup();
  await using _screen = await mount(<Parent />);
  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "p-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("automatic daily summaries of new work");
  expect(container.textContent).toContain("Everyone in this team can read those summaries");
  const form = container.querySelector("form")!;
  const link = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(link.disabled).toBe(true);
  // A direct form submit also cannot skip the acknowledgement.
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.calls.some((command) => command.action === "bind")).toBe(false);
  const acknowledgement = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => acknowledgement.click());
  expect(link.disabled).toBe(false);
  await act(async () => link.click());
  expect(mocks.calls).toContainEqual({ action: "bind", teamId: "team", projectId: "p-2" });
  expect(acknowledgement.checked).toBe(false);
});

it("requires a fresh acknowledgement when the selected project changes", async () => {
  setup();
  await using _screen = await mount(<Parent />);
  const select = container.querySelector<HTMLSelectElement>("select")!;
  const acknowledgement = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => {
    select.value = "p-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => acknowledgement.click());
  expect(acknowledgement.checked).toBe(true);
  await act(async () => {
    select.value = "p-3";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(acknowledgement.checked).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
});
