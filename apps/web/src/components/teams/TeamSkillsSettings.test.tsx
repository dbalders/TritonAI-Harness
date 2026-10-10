// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import {
  ProjectId,
  type TeamProjectCommand,
  type TeamProjectResult,
  TeamsError,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Reply = TeamProjectResult | TeamsError;
const mocks = vi.hoisted(() => ({
  calls: [] as TeamProjectCommand[],
  reply: (_command: TeamProjectCommand): Reply => {
    throw new Error("No reply configured");
  },
}));
vi.mock("../../state/use-atom-command", () => {
  const isTeamsError = Schema.is(TeamsError);
  const request = async ({ input }: { input: TeamProjectCommand }) => {
    mocks.calls.push(input);
    const value = mocks.reply(input);
    return isTeamsError(value)
      ? { _tag: "Failure", cause: Cause.fail(value) }
      : { _tag: "Success", value };
  };
  return { useAtomCommand: () => request };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { teamProjects: "teamProjects" } }));
vi.mock("../../hooks/useUcsdAccount", () => ({
  useUcsdAccount: () => ({
    account: {
      status: "signed-in",
      profile: { issuer: "https://campus.example.test", subject: "alice" },
    },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
// Layout rows only; their scoped-settings plumbing isn't under test here.
vi.mock("../settings/settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  SettingsRow: (props: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
  }) => (
    <div data-row>
      <div>{props.title}</div>
      <div>{props.description}</div>
      <div>{props.status}</div>
      <div>{props.control}</div>
    </div>
  ),
}));
const projectId = ProjectId.make("project-a");
vi.mock("../settings/SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => ({
    scope: { kind: "project", group: { displayName: "Grant reports" } },
    targets: [{ environmentId: "env", label: "This Mac", projectId: "project-a" }],
    groups: [],
    search: {},
    selectScope: () => {},
  }),
}));

import { TeamSkillsSettingsSection } from "./TeamSkillsSettings";

const path = `Skills/${"a".repeat(43)}/device/record.md`;
const moved = "This project's team folder changed. Unlink the project and link it again.";
const link = {
  projectId,
  projectTitle: "Grant reports",
  teamId: "11111111-2222-4333-8444-555555555555",
  teamName: "Alpha",
  linkedAt: "2026-10-09T00:00:00.000Z",
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.calls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<TeamSkillsSettingsSection />));
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
const switches = () => [...container.querySelectorAll<HTMLElement>('[role="switch"]')];
const press = (element: HTMLElement | undefined) => act(async () => element!.click());

it("lets you turn your skills off when the team can't be checked", async () => {
  let on = true;
  mocks.reply = (command) => {
    if (command.action === "skill-disable-all") {
      on = false;
      return { projects: [], storage: null, enabledSkills: [] };
    }
    if (command.action === "skill-enabled")
      return on
        ? {
            projects: [],
            storage: null,
            problem: moved,
            enabledSkills: [
              {
                path,
                title: "Grant summary",
                version: "1".repeat(64),
                state: "unavailable",
                reason: moved,
              },
            ],
          }
        : new TeamsError({ code: "conflict", message: moved });
    throw new Error(`Unexpected ${command.action}`);
  };
  await render();
  // The team folder isn't listed while it can't be checked; your own approval is shown instead.
  expect(mocks.calls).toEqual([{ action: "skill-enabled", projectId }]);
  expect(text()).toContain("Team skills can’t be checked");
  expect(text()).toContain("aren’t sent while these skills are on");
  expect(text()).toContain("Grant summary");
  expect(switches().map((entry) => entry.getAttribute("aria-checked"))).toEqual(["true"]);
  expect(text()).not.toContain("No team skills yet");

  await press(button("Turn all off"));
  expect(mocks.calls.slice(1)).toEqual([
    { action: "skill-disable-all", projectId },
    { action: "skill-enabled", projectId },
  ]);
  expect(switches()).toEqual([]);
  expect(text()).not.toContain("Team skills can’t be checked");
  expect(text()).not.toContain("No team skills yet");
  expect(text()).toContain(moved);
});

it("turns one skill off by its switch while the team can't be checked", async () => {
  mocks.reply = (command) => {
    if (command.action === "skill-disable") return { projects: [], storage: null };
    return {
      projects: [],
      storage: null,
      problem: moved,
      enabledSkills: [
        { path, title: "Grant summary", version: "1".repeat(64), state: "unavailable" },
      ],
    };
  };
  await render();
  await press(switches()[0]);
  expect(mocks.calls[1]).toEqual({ action: "skill-disable", projectId, path });
});

it("doesn't call a team empty when its skills couldn't be listed", async () => {
  mocks.reply = (command) =>
    command.action === "skill-enabled"
      ? { projects: [link], storage: null, enabledSkills: [] }
      : {
          projects: [],
          storage: {
            status: "disconnected",
            account: null,
            flowId: null,
            userCode: null,
            verificationUri: null,
            expiresAt: null,
            retryAfterSeconds: null,
            document: null,
            files: [],
          },
        };
  await render();
  expect(text()).toContain("Connect Microsoft");
  expect(text()).not.toContain("No team skills yet");
});
