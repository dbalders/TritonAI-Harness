import { act, render as renderComponent, type Screen } from "../../../test/render";
import { EnvironmentId, ProjectId, type TeamProjectResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  replies: [] as ((reply: { _tag: "Success"; value: TeamProjectResult }) => void)[],
}));
vi.mock("../../state/use-atom-command", () => {
  const request = () =>
    new Promise<{ _tag: "Success"; value: TeamProjectResult }>((resolve) => {
      mocks.replies.push(resolve);
    });
  return { useAtomCommand: () => request };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { teamProjects: "teamProjects" } }));
vi.mock("../settings/useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));

import { useProjectTeamSkills } from "./useProjectTeamSkills";
import { emitUcsdAccountChanged } from "../../hooks/ucsdAccountEvents";

let container: HTMLElement;
let view: Screen | null = null;
const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project-a");
let teamsEnabled = true;
function SkillsNotice() {
  const value = useProjectTeamSkills(environmentId, projectId, 0, teamsEnabled);
  return (
    <div>
      {value
        ? `${value.teamName}: ${value.skills.map((skill) => skill.title).join(", ")}${value.problem ? ` (${value.problem})` : ""}`
        : ""}
    </div>
  );
}
const reply = (title: string): { _tag: "Success"; value: TeamProjectResult } => ({
  _tag: "Success",
  value: {
    projects: [],
    storage: null,
    enabledSkills: [{ path: "Skills/note.md", title, version: "1".repeat(64), state: "active" }],
  },
});
const changed = () => act(async () => emitUcsdAccountChanged(environmentId));

async function mount(ui: import("react").ReactNode) {
  if (view) await view.rerender(ui);
  else view = await renderComponent(ui, { router: false });
  container = view.container;
  return view;
}

function setup() {
  view = null;
  mocks.replies.length = 0;
  teamsEnabled = true;
}

it("removes the previous account's skill notice while its replacement request is pending", async () => {
  setup();
  await using _screen = await mount(<SkillsNotice />);
  await act(async () => mocks.replies[0]!(reply("Alice's private skill")));
  expect(container.textContent).toContain("Alice's private skill");
  await changed();
  expect(mocks.replies).toHaveLength(2);
  expect(container.textContent).toBe("");
  await act(async () => mocks.replies[1]!(reply("Bob's skill")));
  expect(container.textContent).toContain("Bob's skill");
  expect(container.textContent).not.toContain("Alice");
});

it("ignores a previous account's response that arrives after the account changes", async () => {
  setup();
  await using _screen = await mount(<SkillsNotice />);
  await changed();
  await act(async () => mocks.replies[0]!(reply("Alice's private skill")));
  expect(container.textContent).toBe("");
  await act(async () => mocks.replies[1]!(reply("Bob's skill")));
  expect(container.textContent).toContain("Bob's skill");
});

it("rechecks skills after the experiment is switched on, off, and on again", async () => {
  setup();
  await using _screen = await mount(<SkillsNotice />);
  await act(async () => mocks.replies[0]!(reply("Alice's skill")));
  expect(container.textContent).toContain("Alice's skill");
  teamsEnabled = false;
  await mount(<SkillsNotice />);
  expect(mocks.replies).toHaveLength(2);
  await act(async () =>
    mocks.replies[1]!({
      _tag: "Success",
      value: { ...reply("Alice's skill").value, problem: "Teams is off." },
    }),
  );
  expect(container.textContent).toContain("Teams is off.");
  teamsEnabled = true;
  await mount(<SkillsNotice />);
  expect(mocks.replies).toHaveLength(3);
  await act(async () => mocks.replies[2]!(reply("Alice's updated skill")));
  expect(container.textContent).toContain("Alice's updated skill");
  expect(container.textContent).not.toContain("Teams is off.");
});
