// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, type TeamProjectCommand } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("./TeamDocuments", () => ({ TeamDocuments: () => null }));

import { TeamProjects } from "./TeamProjects";

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
  await act(async () => root.render(<Parent />));
  for (let settle = 0; settle < 5; settle++) await act(async () => {});
  expect(mocks.calls).toEqual([{ action: "list", teamId: "team" }]);
  expect(container.querySelector("[data-notices]")?.getAttribute("data-notices")).toBe("1");
  expect(container.textContent).toContain("Linked");
});
