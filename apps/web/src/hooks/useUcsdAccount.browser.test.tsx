import { act, render as renderComponent, type Screen } from "../../test/render";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  formatTeamMemoryContext,
  type AccountStatus,
  type TeamProjectResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  statuses: new Map<EnvironmentId, AccountStatus>(),
  calls: [] as { kind: string; environmentId: EnvironmentId }[],
  teams: [] as {
    environmentId: EnvironmentId;
    resolve: (reply: { _tag: "Success"; value: TeamProjectResult }) => void;
  }[],
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: vi.fn() } }),
}));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    getAccountStatus: { tag: "check" },
    startAccountLogin: { tag: "start", permissionAtom: () => true },
    pollAccountLogin: { tag: "poll" },
    signOutAccount: { tag: "signOut", permissionAtom: () => true },
    teamProjects: { tag: "teams" },
  },
}));
vi.mock("../state/session", () => {
  const prepared = { _tag: "Some" };
  return { usePreparedConnection: () => prepared };
});
vi.mock("../state/threads", () => ({ threadEnvironment: { setTeamSharing: "setTeamSharing" } }));
vi.mock("../state/entities", () => ({ readEnvironmentSupportsTeamSharing: () => true }));
vi.mock("../components/settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => [],
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../state/use-atom-command", () => {
  const requests = Object.fromEntries(
    ["check", "start", "poll", "signOut", "teams"].map((kind) => [
      kind,
      async ({ environmentId }: { environmentId: EnvironmentId }) => {
        mocks.calls.push({ kind, environmentId });
        if (kind === "teams")
          return new Promise<{ _tag: "Success"; value: TeamProjectResult }>((resolve) =>
            mocks.teams.push({ environmentId, resolve }),
          );
        const current = mocks.statuses.get(environmentId)!;
        const next: AccountStatus =
          kind === "signOut" ? { ...current, status: "signed-out", profile: null } : current;
        mocks.statuses.set(environmentId, next);
        return {
          _tag: "Success",
          value: { ...next, profile: next.profile && { ...next.profile } },
        };
      },
    ]),
  );
  return { useAtomCommand: ({ tag }: { tag: string }) => requests[tag] };
});

import { useUcsdAccount } from "./useUcsdAccount";
import { useProjectTeamSharing } from "../components/teams/useProjectTeamSharing";
import { useProjectTeamSkills } from "../components/teams/useProjectTeamSkills";
import { useComposerDraftStore } from "../composerDraftStore";
import { addDraftTeamMemory, useDraftTeamMemoryStore } from "../components/teams/teamMemoryDrafts";

let view: Screen | null = null;
let container: HTMLElement;
let environmentA: EnvironmentId;
let environmentB: EnvironmentId;
let generation = 0;
let changes: EnvironmentId[];
const changed = (event: Event) => {
  changes.push((event as CustomEvent<{ environmentId: EnvironmentId }>).detail?.environmentId);
};
const projectId = ProjectId.make("project");
const status = (name: string): AccountStatus => ({
  configured: true,
  status: "signed-in",
  serviceUrl: "https://campus.example.test",
  profile: {
    issuer: "https://campus.example.test",
    subject: name,
    displayName: name,
    email: `${name}@example.test`,
  },
  expiresAt: null,
  verificationUrl: null,
  userCode: null,
  pollIntervalSeconds: null,
});
function Account({ environmentId, id }: { environmentId: EnvironmentId; id: string }) {
  const { account, controller } = useUcsdAccount(environmentId);
  return (
    <div>
      <span data-account={id}>{account?.profile?.subject ?? account?.status ?? "unknown"}</span>
      <button onClick={() => void controller.check()}>Check {id}</button>
      <button onClick={() => void controller.signOut()}>Sign out {id}</button>
    </div>
  );
}
function Notices({ environmentId }: { environmentId: EnvironmentId }) {
  const sharing = useProjectTeamSharing(environmentId, projectId, 0);
  const skills = useProjectTeamSkills(environmentId, projectId, 0);
  return (
    <output data-notices={environmentId}>
      {sharing?.teamName ?? "none"} /{" "}
      {skills?.skills.map((skill) => skill.title).join(", ") ?? "none"}
    </output>
  );
}
async function renderView(second = false) {
  const ui = (
    <>
      <Notices environmentId={environmentA} />
      <Notices environmentId={environmentB} />
      <Account environmentId={environmentA} id="first" />
      <Account environmentId={environmentB} id="other environment" />
      {second ? <Account environmentId={environmentA} id="second" /> : null}
    </>
  );
  if (view) await view.rerender(ui);
  else view = await renderComponent(ui, { router: false });
  container = view.container;
  return view;
}
const notice = (environmentId: EnvironmentId) =>
  container.querySelector(`[data-notices="${environmentId}"]`)?.textContent;
const press = (label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click();
  });
const settleTeams = () =>
  act(async () => {
    for (const { environmentId, resolve } of mocks.teams.splice(0)) {
      const name = mocks.statuses.get(environmentId)?.profile?.subject;
      resolve({
        _tag: "Success",
        value: {
          projects: [],
          storage: null,
          enabledSkills: name
            ? [
                {
                  path: "Skills/note.md",
                  title: `${name}'s skill`,
                  version: "1".repeat(64),
                  state: "active",
                },
              ]
            : [],
          ...(name
            ? {
                sharing: {
                  teamId: "team",
                  teamName: `${name}'s team`,
                  state: "sharing",
                  message: null,
                  lastPublishedAt: null,
                },
              }
            : {}),
        },
      });
    }
  });
const calls = (kind: string, environmentId?: EnvironmentId) =>
  mocks.calls.filter(
    (call) => call.kind === kind && (!environmentId || call.environmentId === environmentId),
  );

function setup() {
  view = null;
  environmentA = EnvironmentId.make(`account-a-${generation++}`);
  environmentB = EnvironmentId.make(`account-b-${generation++}`);
  mocks.statuses.clear();
  mocks.statuses.set(environmentA, status("Alice"));
  mocks.statuses.set(environmentB, status("Other"));
  mocks.calls = [];
  mocks.teams = [];
  changes = [];
  useDraftTeamMemoryStore.setState({ entries: [], inheritedReferences: {}, problems: {} });
  window.addEventListener("tritonai-account-changed", changed);
  return {
    [Symbol.dispose]: () => window.removeEventListener("tritonai-account-changed", changed),
  };
}

it("keeps loaded notices when a second account consumer mounts or the same account reloads", async () => {
  using _setup = setup();
  await using _screen = await renderView();
  await settleTeams();
  expect(notice(environmentA)).toContain("Alice's team / Alice's skill");
  expect(calls("teams")).toHaveLength(4);
  await renderView(true);
  expect(calls("check", environmentA)).toHaveLength(2);
  expect(calls("teams")).toHaveLength(4);
  expect(notice(environmentA)).toContain("Alice's team / Alice's skill");
  await press("Check first");
  expect(calls("teams")).toHaveLength(4);
  expect(notice(environmentA)).toContain("Alice's team / Alice's skill");
  expect(changes).toEqual([]);
});

it("invalidates a real switch and sign-out once, only in their environment", async () => {
  using _setup = setup();
  await using _screen = await renderView(true);
  await settleTeams();
  const otherNotice = notice(environmentB);
  mocks.statuses.set(environmentA, status("Bob"));
  await press("Check first");
  expect(changes).toEqual([environmentA]);
  expect(notice(environmentA)).not.toContain("Alice");
  expect(notice(environmentB)).toBe(otherNotice);
  expect(calls("check", environmentB)).toHaveLength(1);
  expect(calls("teams", environmentB)).toHaveLength(2);
  expect(mocks.teams).toHaveLength(2);
  await settleTeams();
  expect(notice(environmentA)).toContain("Bob's team / Bob's skill");
  await press("Sign out first");
  expect(changes).toEqual([environmentA, environmentA]);
  expect(notice(environmentA)).not.toContain("Bob");
  expect(notice(environmentB)).toBe(otherNotice);
  expect(calls("check", environmentB)).toHaveLength(1);
  expect(calls("teams", environmentB)).toHaveLength(2);
  expect(container.querySelector('[data-account="second"]')?.textContent).toBe("signed-out");
});

it("reconciles persisted draft text on the first known account without broadcasting a change", async () => {
  using _setup = setup();
  const target = scopeThreadRef(environmentA, ThreadId.make("draft"));
  const block = formatTeamMemoryContext({
    teamName: "Team",
    path: "Memory/note.md",
    text: "Private note from the old account.",
  });
  addDraftTeamMemory(
    {
      id: "old",
      projectId,
      teamName: "Team",
      path: "Memory/note.md",
      block,
      thread: target,
      environmentId: environmentA,
      identity: "https://campus.example.test:Previous",
    },
    () => {
      useComposerDraftStore.getState().setPrompt(target, `Personal text\n\n${block}`);
      return true;
    },
  );
  await using _screen = await renderView();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe("Personal text");
  expect(useDraftTeamMemoryStore.getState().entries).toEqual([]);
  expect(changes).toEqual([]);
});
