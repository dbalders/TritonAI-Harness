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

it("drops the earlier team listing when a reload can't check the team", async () => {
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
  await render();
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
  await render();
  await press(button("Review update"));
  const review = document.body.textContent ?? "";
  expect(review).toContain("Review the update to “Grant summary”");
  expect(review).toContain("Last changed by");
  expect(review).toContain("Bob Editor");
});
