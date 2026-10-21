// @vitest-environment jsdom
import { formatTeamNote, TeamStorageCommand, type TeamStorageStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { TeamDocuments } from "./TeamDocuments";

const teamId = "11111111-2222-4333-8444-555555555555";
const path = `Memory/${"a".repeat(43)}/device/record.md`;
const status: TeamStorageStatus = {
  status: "connected",
  account: null,
  flowId: null,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  retryAfterSeconds: null,
  document: null,
  files: [],
};
const owner = { by: "Alice Owner", at: "2026-10-08T12:00:00.000Z" };
const editor = { by: "Bob Editor", at: "2026-10-09T12:00:00.000Z" };
const current = { path, etag: "e2", text: "Current text", lastChange: editor };

let root: Root;
let container: HTMLDivElement;
let calls: TeamStorageCommand[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const run = async (command: TeamStorageCommand) => {
  calls.push(command);
  if (command.action === "list-versions")
    return {
      ...status,
      history: {
        path,
        versions: [
          { id: "2.0", size: 12, change: editor },
          { id: "1.0", size: 13, change: owner },
        ],
      },
    };
  if (command.action === "read-version")
    return {
      ...status,
      priorVersion: { path, version: { id: "1.0", size: 13, change: owner }, text: "Earlier text" },
    };
  return null;
};
const render = (document = current, canWrite = false) =>
  act(async () =>
    root.render(
      <TeamDocuments
        teamId={teamId}
        document={document}
        files={[]}
        canWrite={canWrite}
        busy={false}
        run={run}
      />,
    ),
  );
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label || entry.getAttribute("aria-label") === label,
  );
const press = (label: string) => act(async () => button(label)!.click());
const earlier = () =>
  container.querySelector<HTMLTextAreaElement>('[aria-label="Earlier version content"]');

it("lets a reader see who changed a document and read an earlier version", async () => {
  await render();
  expect(text()).toContain("Last changed by Bob Editor");
  await press("History");
  expect(text()).toContain("Version 2.0 · current");
  expect(button("Read version 2.0")?.disabled).toBe(true);
  await press("Read version 2.0");
  expect(calls).toEqual([{ action: "list-versions", teamId, path }]);
  expect(text()).toContain("Alice Owner");
  await press("Read version 1.0");
  expect(earlier()?.value).toBe("Earlier text");
  expect(earlier()?.readOnly).toBe(true);
  expect(calls).toEqual([
    { action: "list-versions", teamId, path },
    { action: "read-version", teamId, path, versionId: "1.0" },
  ]);
  // A newer version of the document closes the history it no longer matches.
  await render({ ...current, etag: "e3", text: "Newer text" });
  expect(earlier()).toBeNull();
  expect(button("History")).toBeDefined();
});

it("keeps an unsaved edit when a refresh returns a new object for the same document version", async () => {
  await render(current, true);
  const content = container.querySelector<HTMLTextAreaElement>(
    '[aria-label="Shared document content"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      content,
      "My unsaved edit",
    );
    content.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render({ ...current, lastChange: { ...editor } }, true);
  expect(content.value).toBe("My unsaved edit");
});

it("can edit and save a formatted document accepted at the publishing body limit", async () => {
  const published: Extract<TeamStorageCommand, { action: "publish" }> = {
    action: "publish",
    teamId,
    recordId: teamId,
    deviceId: teamId,
    kind: "memory",
    title: "Pilot findings",
    project: "Pilot project",
    text: "x".repeat(60_000),
  };
  const isCommand = Schema.is(TeamStorageCommand);
  expect(isCommand(published)).toBe(true);
  const saved = formatTeamNote(published);
  expect(saved.length).toBeGreaterThan(60_000);
  await render({ ...current, text: saved }, true);
  const content = container.querySelector<HTMLTextAreaElement>(
    '[aria-label="Shared document content"]',
  )!;
  const edited = `${saved}\nReviewed.`;
  expect(content.maxLength).toBeGreaterThanOrEqual(edited.length);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      content,
      edited,
    );
    content.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await press("Save changes");
  expect(calls).toEqual([
    { action: "update-file", teamId, path, etag: current.etag, text: edited },
  ]);
  expect(isCommand(calls[0])).toBe(true);
});
