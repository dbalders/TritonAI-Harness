// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  type TeamProjectCommand,
  type TeamStorageCommand,
  type TeamStorageStatus,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<TeamProjectCommand | TeamStorageCommand>,
  disconnected: false,
  reconnect: false,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { teamProjects: "projects", teamStorage: "storage" },
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (tag: string) => (tag === "storage" ? storageRequest : projectRequest),
}));

import { TeamSharedStorage } from "./TeamSharedStorage";
import { TeamProjects } from "./TeamProjects";
const teamId = "11111111-2222-4333-8444-555555555555";
const path = `Memory/${"a".repeat(43)}/device/record.md`;
const current = { path, etag: "e1", text: "Published document" };
const status = (state: TeamStorageStatus["status"] = "connected"): TeamStorageStatus => ({
  status: state,
  account: null,
  flowId: state === "pending" ? "reconnect-flow" : null,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  retryAfterSeconds: 1,
  document: state === "connected" ? current : null,
  files: [],
});
const storageRequest = async ({ input }: { input: TeamStorageCommand }) => {
  mocks.calls.push(input);
  if (input.action === "update-file" || input.action === "publish") mocks.disconnected = true;
  const next =
    input.action === "connect"
      ? status("pending")
      : input.action === "poll"
        ? { ...status(), document: null }
        : status(mocks.disconnected ? "disconnected" : "connected");
  return { _tag: "Success", value: next };
};
const link = {
  projectId: "project",
  projectTitle: "Pilot project",
  teamId,
  teamName: "Alpha",
  sharingSince: "2026-10-01",
};
const projectRequest = async ({ input }: { input: TeamProjectCommand }) => {
  mocks.calls.push(input);
  if (input.action === "memory-update" || input.action === "memory-publish")
    mocks.disconnected = true;
  const storage =
    input.action === "list"
      ? null
      : status(mocks.disconnected && !mocks.reconnect ? "disconnected" : "connected");
  return { _tag: "Success", value: { projects: [link], storage, authors: [] } };
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.calls = [];
  mocks.disconnected = false;
  mocks.reconnect = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const field = (label: string) =>
  container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const type = (label: string, value: string) =>
  act(async () => {
    const element = field(label);
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
const press = (label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === label)!
      .click();
  });
const edit = async () => {
  await type("Document title", "Unpublished title");
  await type("New document content", "Unpublished note");
  await type("Shared document content", "My unsaved document edit");
};
const expectDrafts = () => {
  expect(field("Document title").value).toBe("Unpublished title");
  expect(field("New document content").value).toBe("Unpublished note");
  expect(field("Shared document content").value).toBe("My unsaved document edit");
};

it("retains shared-storage edits through disconnected and pending Microsoft states", async () => {
  vi.useFakeTimers();
  await act(async () =>
    root.render(
      <TeamSharedStorage environmentId={EnvironmentId.make("env")} teamId={teamId} canWrite />,
    ),
  );
  await edit();
  await press("Save changes");
  expectDrafts();
  expect(field("Shared document content").disabled).toBe(true);
  await press("Connect Microsoft");
  expectDrafts();
  expect(field("New document content").disabled).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expectDrafts();
  expect(field("Shared document content").disabled).toBe(false);
  expect(mocks.calls.some((command) => command.action === "poll")).toBe(true);
});

it("retains linked-project document drafts when a save needs Microsoft reconnection", async () => {
  await act(async () =>
    root.render(
      <TeamProjects
        environmentId={EnvironmentId.make("env")}
        teamId={teamId}
        linkProjectId={null}
        canWrite
      />,
    ),
  );
  await press("Open team memory");
  await edit();
  await press("Save changes");
  expectDrafts();
  expect(field("Shared document content").disabled).toBe(true);
  mocks.reconnect = true;
  await press("Refresh team memory");
  expectDrafts();
  expect(field("Shared document content").disabled).toBe(false);
});
