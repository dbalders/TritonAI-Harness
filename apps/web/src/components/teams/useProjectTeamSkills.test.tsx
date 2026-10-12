// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId, type TeamProjectResult } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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

let container: HTMLDivElement;
let root: Root;
const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project-a");
function SkillsNotice() {
  const value = useProjectTeamSkills(environmentId, projectId, 0);
  return (
    <div>
      {value ? `${value.teamName}: ${value.skills.map((skill) => skill.title).join(", ")}` : ""}
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
const changed = () => act(async () => window.dispatchEvent(new Event("tritonai-account-changed")));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.replies.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("removes the previous account's skill notice while its replacement request is pending", async () => {
  await act(async () => root.render(<SkillsNotice />));
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
  await act(async () => root.render(<SkillsNotice />));
  await changed();
  await act(async () => mocks.replies[0]!(reply("Alice's private skill")));
  expect(container.textContent).toBe("");
  await act(async () => mocks.replies[1]!(reply("Bob's skill")));
  expect(container.textContent).toContain("Bob's skill");
});
