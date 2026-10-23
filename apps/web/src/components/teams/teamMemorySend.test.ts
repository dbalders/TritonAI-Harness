import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  draftTeamMemoryAccountRevision,
  reconcileDraftTeamMemoryAccount,
} from "./teamMemoryDrafts";
import { verifyTeamMemorySend } from "./teamMemorySend";

const environmentId = EnvironmentId.make("verification-environment");
const target = scopeThreadRef(environmentId, ThreadId.make("thread"));
const prompt = "A team note remains in this draft";
const pendingCheck = () => {
  let resolve: (problem: string | null) => void = () => {
    throw new Error("Check was not started");
  };
  const promise = new Promise<string | null>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};
let mount: object;
let route: string | null;
let references: string[];
let handle: { getDraftIdentity: () => object };
const readCurrent = () => ({
  editorIdentity: handle.getDraftIdentity(),
  routeKey: route,
  accountRevision: draftTeamMemoryAccountRevision(environmentId),
  prompt: useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "",
  references,
  draft: useComposerDraftStore.getState().getComposerDraft(target),
});
beforeEach(() => {
  mount = {};
  handle = { getDraftIdentity: () => mount };
  route = "environment:thread";
  references = ["reference"];
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useComposerDraftStore.getState().setPrompt(target, prompt);
  reconcileDraftTeamMemoryAccount(environmentId, "campus:alice");
});

it("continues after the send-triggered render recreates the handle and clones default draft state", async () => {
  const response = pendingCheck();
  const verify = vi.fn(() => response.promise);
  const checked = verifyTeamMemorySend({ readCurrent, verify });
  handle = { getDraftIdentity: () => mount };
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, prompt);
  store.setFiles(target, []);
  store.setModelSelection(target, {
    instanceId: ProviderInstanceId.make("codex"),
    model: "test-model",
  });
  reconcileDraftTeamMemoryAccount(environmentId, "campus:alice");
  response.resolve(null);
  expect(await checked).toEqual({ status: "ready" });
  expect(verify).toHaveBeenCalledWith(["reference"]);
});

it("returns the access problem after ordinary render churn instead of silently dropping it", async () => {
  const response = pendingCheck();
  const checked = verifyTeamMemorySend({ readCurrent, verify: () => response.promise });
  handle = { getDraftIdentity: () => mount };
  useComposerDraftStore.getState().setPrompt(target, prompt);
  response.resolve("Team unavailable");
  expect(await checked).toEqual({ status: "denied", problem: "Team unavailable" });
});

it.each([
  {
    name: "prompt edit",
    change: () => useComposerDraftStore.getState().setPrompt(target, "Edited while checking"),
  },
  {
    name: "reference replacement",
    change: () => {
      references = ["different-reference"];
    },
  },
  {
    name: "editor remount or draft target switch",
    change: () => {
      mount = {};
    },
  },
  {
    name: "thread switch",
    change: () => {
      route = "different-thread";
    },
  },
  {
    name: "unmount",
    change: () => {
      route = null;
    },
  },
  {
    name: "account switch away and back",
    change: () => {
      reconcileDraftTeamMemoryAccount(environmentId, "campus:bob");
      reconcileDraftTeamMemoryAccount(environmentId, "campus:alice");
    },
  },
  {
    name: "new attachment",
    change: () =>
      useComposerDraftStore.getState().setFiles(target, [
        {
          type: "file",
          id: "new-file",
          name: "new.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
          file: null,
        },
      ]),
  },
])("discards a stale answer after $name", async ({ change }) => {
  const response = pendingCheck();
  const checked = verifyTeamMemorySend({ readCurrent, verify: () => response.promise });
  change();
  response.resolve(null);
  expect(await checked).toEqual({ status: "stale" });
});
