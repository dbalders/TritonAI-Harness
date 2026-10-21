// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId, TeamsError, type TeamProjectResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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

let container: HTMLDivElement;
let root: Root;
let sent = 0;
function SharingNotice() {
  const value = useProjectTeamSharing(EnvironmentId.make("env"), ProjectId.make("project"), sent);
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
  await act(async () => root.render(<SharingNotice />));
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.replies.length = 0;
  sent = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps a known team, as waiting, when a refresh fails, and recovers", async () => {
  await act(async () => root.render(<SharingNotice />));
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
  await act(async () => root.render(<SharingNotice />));
  await act(async () => mocks.replies[0]!(shared("Alpha")));
  await refresh();
  await act(async () => mocks.replies[1]!(failed("not_found")));
  expect(container.textContent).toBe("none");
});

it("shows nothing of the previous account after the account changes, even if its check fails", async () => {
  await act(async () => root.render(<SharingNotice />));
  await act(async () => mocks.replies[0]!(shared("Alice's team")));
  await act(async () => emitUcsdAccountChanged(EnvironmentId.make("env")));
  expect(container.textContent).toBe("none");
  await act(async () => mocks.replies[1]!(failed("unavailable")));
  expect(container.textContent).toBe("none");
});
