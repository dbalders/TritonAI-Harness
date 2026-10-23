import { act, render as renderComponent, type Screen } from "../../../test/render";
import { EnvironmentId, ProjectId, TeamsError, type TeamProjectResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";

type Reply =
  | { _tag: "Success"; value: TeamProjectResult }
  | { _tag: "Failure"; cause: Cause.Cause<unknown> };
const mocks = vi.hoisted(() => ({ replies: [] as ((reply: Reply) => void)[] }));
vi.mock("../../state/use-atom-command", () => {
  const request = () => new Promise<Reply>((resolve) => mocks.replies.push(resolve));
  return { useAtomCommand: () => request };
});
vi.mock("../../state/server", () => ({ serverEnvironment: { teamProjects: "teamProjects" } }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { setTeamSharing: "setTeamSharing" } }));
vi.mock("../../state/entities", () => ({ readEnvironmentSupportsTeamSharing: () => true }));

import { useProjectTeamSharing } from "./useProjectTeamSharing";
import { emitUcsdAccountChanged } from "../../hooks/ucsdAccountEvents";

let container: HTMLElement;
let view: Screen | null = null;
let sent = 0;
let teamsEnabled = true;
function SharingNotice() {
  const value = useProjectTeamSharing(
    EnvironmentId.make("env"),
    ProjectId.make("project"),
    sent,
    teamsEnabled,
  );
  return <div>{value ? `${value.teamName}:${value.state}:${value.message ?? ""}` : "none"}</div>;
}
const shared = (teamName: string): Reply => ({
  _tag: "Success",
  value: {
    projects: [],
    storage: null,
    sharing: {
      teamId: "11111111-2222-4333-8444-555555555555",
      teamName,
      state: "sharing",
      message: null,
      lastPublishedAt: null,
    },
  },
});
const failed = (code: "unavailable" | "not_found"): Reply => ({
  _tag: "Failure",
  cause: Cause.fail(new TeamsError({ code, message: `Teams said ${code}.` })),
});
const refresh = async () => {
  sent++;
  await mount(<SharingNotice />);
};

async function mount(ui: import("react").ReactNode) {
  if (view) await view.rerender(ui);
  else view = await renderComponent(ui, { router: false });
  container = view.container;
  return view;
}

function setup() {
  view = null;
  mocks.replies.length = 0;
  sent = 0;
  teamsEnabled = true;
}

it("keeps a known team, as waiting, when a refresh fails, and recovers", async () => {
  setup();
  await using _screen = await mount(<SharingNotice />);
  await act(async () => mocks.replies[0]!(shared("Alpha")));
  expect(container.textContent).toBe("Alpha:sharing:");
  await refresh();
  await act(async () => mocks.replies[1]!(failed("unavailable")));
  // The team stays shown, so the thread can still be kept out of it.
  expect(container.textContent).toBe("Alpha:held:Teams said unavailable.");
  await refresh();
  await act(async () => mocks.replies[2]!(shared("Alpha")));
  expect(container.textContent).toBe("Alpha:sharing:");
});

it("clears the team on a definite answer that the project isn't shared", async () => {
  setup();
  await using _screen = await mount(<SharingNotice />);
  await act(async () => mocks.replies[0]!(shared("Alpha")));
  await refresh();
  await act(async () => mocks.replies[1]!(failed("not_found")));
  expect(container.textContent).toBe("none");
});

it("shows nothing of the previous account after the account changes, even if its check fails", async () => {
  setup();
  await using _screen = await mount(<SharingNotice />);
  await act(async () => mocks.replies[0]!(shared("Alice's team")));
  await act(async () => emitUcsdAccountChanged(EnvironmentId.make("env")));
  expect(container.textContent).toBe("none");
  await act(async () => mocks.replies[1]!(failed("unavailable")));
  expect(container.textContent).toBe("none");
});

it("rechecks sharing after the experiment is switched on, off, and on again", async () => {
  setup();
  await using _screen = await mount(<SharingNotice />);
  await act(async () => mocks.replies[0]!(shared("Alpha")));
  expect(container.textContent).toBe("Alpha:sharing:");
  teamsEnabled = false;
  await mount(<SharingNotice />);
  expect(mocks.replies).toHaveLength(2);
  await act(async () =>
    mocks.replies[1]!({
      _tag: "Success",
      value: {
        projects: [],
        storage: null,
        sharing: {
          teamId: "11111111-2222-4333-8444-555555555555",
          teamName: "Alpha",
          state: "held",
          message: "Teams is off.",
          lastPublishedAt: null,
        },
      },
    }),
  );
  expect(container.textContent).toBe("Alpha:held:Teams is off.");
  teamsEnabled = true;
  await mount(<SharingNotice />);
  expect(mocks.replies).toHaveLength(3);
  await act(async () => mocks.replies[2]!(shared("Alpha")));
  expect(container.textContent).toBe("Alpha:sharing:");
});
