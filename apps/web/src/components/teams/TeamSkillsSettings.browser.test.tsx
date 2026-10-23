import { act, render as renderComponent, type Screen } from "../../../test/render";
import type { ReactNode } from "react";
import * as Cause from "effect/Cause";
import {
  ProjectId,
  type TeamProjectCommand,
  type TeamProjectResult,
  TeamsError,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

type Reply = TeamProjectResult | TeamsError;
const mocks = vi.hoisted(() => ({
  enabled: true,
  calls: [] as TeamProjectCommand[],
  reply: (_command: TeamProjectCommand): Reply => {
    throw new Error("No reply configured");
  },
}));
vi.mock("../../state/use-atom-command", async () => {
  const Schema = await import("effect/Schema");
  const { TeamsError } = await import("@t3tools/contracts");
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
vi.mock("./useTeamsEnabled", () => ({
  useTeamsEnabled: () => mocks.enabled,
  useTeamsEnabledEnvironments: (targets: { environmentId: string }[]) =>
    new Set(mocks.enabled ? targets.map((target) => target.environmentId) : []),
}));
vi.mock("../../state/entities", () => ({ useProject: () => null, useProjects: () => [] }));
vi.mock("../../state/server", () => ({ serverEnvironment: { teamProjects: "teamProjects" } }));
vi.mock("../../hooks/useUcsdAccount", () => ({
  useUcsdAccount: () => ({
    account: {
      status: "signed-in",
      profile: { issuer: "https://campus.example.test", subject: "alice" },
    },
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
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
  mocks.enabled = true;
  mocks.calls = [];
}

const renderView = () => mount(<TeamSkillsSettingsSection />);
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
const switches = () => [...container.querySelectorAll<HTMLElement>('[role="switch"]')];
const press = (element: HTMLElement | undefined) => act(async () => element!.click());

it("lets you turn your skills off when the team can't be checked", async () => {
  setup();
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
  await using _screen = await renderView();
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
  setup();
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
  await using _screen = await renderView();
  await press(switches()[0]);
  expect(mocks.calls[1]).toEqual({ action: "skill-disable", projectId, path });
});

it("shows an empty approval list's problem and recovers through Retry", async () => {
  setup();
  let available = false;
  mocks.reply = (command) => {
    if (command.action === "skill-enabled")
      return available
        ? { projects: [link], storage: null, enabledSkills: [] }
        : { projects: [], storage: null, enabledSkills: [], problem: moved };
    if (command.action === "skill-list")
      return {
        projects: [],
        storage: {
          status: "connected",
          account: null,
          flowId: null,
          userCode: null,
          verificationUri: null,
          expiresAt: null,
          retryAfterSeconds: null,
          document: null,
          files: [
            {
              id: "1",
              path,
              etag: "e",
              size: 1,
              summary: { title: "Grant summary", description: "Summaries", hidden: false },
            },
          ],
        },
      };
    throw new Error(`Unexpected ${command.action}`);
  };
  await using _screen = await renderView();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(moved);
  expect(text()).toContain("No team skills are on for you");
  expect(text()).not.toContain("aren’t sent");
  expect(button("Turn all off")).toBeUndefined();
  expect(button("Retry")).toBeDefined();
  expect(text()).not.toContain("No team skills yet");
  available = true;
  await press(button("Retry"));
  expect(mocks.calls).toEqual([
    { action: "skill-enabled", projectId },
    { action: "skill-enabled", projectId },
    { action: "skill-list", projectId },
  ]);
  expect(text()).toContain("Grant summary");
  expect(switches()[0]?.getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button("Retry")).toBeUndefined();
});

it("doesn't call a team empty when its skills couldn't be listed", async () => {
  setup();
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
  await using _screen = await renderView();
  expect(text()).toContain("Connect Microsoft");
  expect(text()).not.toContain("No team skills yet");
});

it("drops the earlier team listing when a reload can't check the team", async () => {
  setup();
  const other = `Skills/${"a".repeat(43)}/device/other.md`;
  let disabled = false;
  const listing = {
    status: "connected" as const,
    account: null,
    flowId: null,
    userCode: null,
    verificationUri: null,
    expiresAt: null,
    retryAfterSeconds: null,
    document: null,
    files: [
      {
        id: "1",
        path,
        etag: "e",
        size: 1,
        summary: { title: "Grant summary", description: "Summaries", hidden: false },
      },
      {
        id: "2",
        path: other,
        etag: "e",
        size: 1,
        summary: { title: "Agenda", description: "Meetings", hidden: false },
      },
    ],
  };
  const second = `Skills/${"a".repeat(43)}/device/second.md`;
  mocks.reply = (command) => {
    if (command.action === "skill-disable") {
      disabled = true;
      return { projects: [], storage: null };
    }
    if (command.action === "skill-list")
      return { projects: [], storage: listing, authors: { ["a".repeat(43)]: "Alice" } };
    if (command.action !== "skill-enabled") throw new Error(`Unexpected ${command.action}`);
    return disabled
      ? {
          projects: [],
          storage: null,
          problem: moved,
          enabledSkills: [
            { path: second, title: "Second skill", version: "2".repeat(64), state: "unavailable" },
          ],
        }
      : {
          projects: [link],
          storage: null,
          enabledSkills: [
            { path, title: "Grant summary", version: "1".repeat(64), state: "active" },
            { path: second, title: "Second skill", version: "2".repeat(64), state: "active" },
          ],
        };
  };
  await using _screen = await renderView();
  expect(text()).toContain("Agenda");
  expect(text()).toContain("From Alice");
  // Turning one off reloads; this time the team can't be checked.
  await press(switches()[0]);
  expect(text()).toContain("Team skills can’t be checked");
  expect(text()).toContain("Second skill");
  expect(text()).toContain("Previously reviewed skill");
  expect(text()).not.toContain("Agenda");
  expect(text()).not.toContain("From Alice");
  expect(text()).not.toContain("Skills from Alpha");
  expect(switches()).toHaveLength(1);
});

it("shows who last changed a skill when its update is reviewed", async () => {
  setup();
  mocks.reply = (command) => {
    if (command.action === "skill-enabled")
      return {
        projects: [link],
        storage: null,
        enabledSkills: [
          {
            path,
            title: "Grant summary",
            version: "1".repeat(64),
            state: "needs-review",
            currentVersion: "2".repeat(64),
          },
        ],
      };
    if (command.action === "skill-list")
      return {
        projects: [],
        storage: {
          status: "connected",
          account: null,
          flowId: null,
          userCode: null,
          verificationUri: null,
          expiresAt: null,
          retryAfterSeconds: null,
          document: null,
          files: [{ id: "1", path, etag: "e", size: 1 }],
        },
      };
    if (command.action === "skill-read")
      return {
        projects: [],
        version: "2".repeat(64),
        storage: {
          status: "connected",
          account: null,
          flowId: null,
          userCode: null,
          verificationUri: null,
          expiresAt: null,
          retryAfterSeconds: null,
          files: [],
          document: {
            path,
            etag: "e2",
            text: "# Grant summary\n\nDescription: Summaries\n\nRewritten steps.",
            lastChange: { by: "Bob Editor", at: "2026-10-09T12:00:00.000Z" },
          },
        },
      };
    throw new Error(`Unexpected ${command.action}`);
  };
  await using _screen = await renderView();
  await press(button("Review update"));
  const review = document.body.textContent ?? "";
  expect(review).toContain("Review the update to “Grant summary”");
  expect(review).toContain("Last changed by");
  expect(review).toContain("Bob Editor");
});

it("hides Team Skills and makes no Teams requests while the experiment is off", async () => {
  setup();
  mocks.enabled = false;
  await using _screen = await renderView();
  expect(text()).toBe("");
  expect(mocks.calls).toEqual([]);
});
