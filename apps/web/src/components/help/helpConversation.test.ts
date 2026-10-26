import { EnvironmentId, type HelpAskResult, type HelpContext } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createHelpConversation,
  helpConversationFor,
  helpFailureMessage,
  shouldSubmitHelpComposer,
} from "./helpConversation";
import { HELP_ISSUE_TRACKER_URL, resolveHelpLink } from "./helpLinks";

const context: HelpContext = {
  capturedAt: "2026-10-22T12:00:00Z",
  environmentId: EnvironmentId.make("test"),
  environmentName: "Test host",
  version: "0.3.1",
  platform: "darwin",
  mode: "desktop",
  paths: [],
  providers: [],
  modelLabel: "Codex",
  diagnostics: {
    recordCount: 0,
    failureCount: 0,
    slowSpanCount: 0,
    partial: false,
    recentFailures: [],
  },
};
const answer: HelpAskResult = { answer: "Open Settings > Providers.", context };
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Help conversation", () => {
  it("retains pending across navigation without duplicating a request", async () => {
    const connection = { environmentId: "same-environment" };
    const mounted = helpConversationFor(connection);
    const response = deferred<HelpAskResult>();
    const ask = vi.fn(() => response.promise);
    mounted.setDraft("Help me connect a plugin.");
    const running = mounted.send(ask);
    const unsubscribe = mounted.subscribe(vi.fn());
    unsubscribe();
    const reopened = helpConversationFor(connection);
    expect(reopened).toBe(mounted);
    expect(reopened.getSnapshot().pendingQuestion).toBe("Help me connect a plugin.");
    await reopened.send(ask);
    expect(ask).toHaveBeenCalledTimes(1);
    response.resolve(answer);
    await running;
    expect(reopened.getSnapshot().messages).toHaveLength(2);
  });

  it("separates prepared connections even when environment IDs are equal", async () => {
    const first = helpConversationFor({
      environmentId: "same",
      authorization: { account: "first" },
    });
    const second = helpConversationFor({
      environmentId: "same",
      authorization: { account: "second" },
    });
    const response = deferred<HelpAskResult>();
    first.setDraft("First account question");
    const running = first.send(() => response.promise);
    expect(second.getSnapshot().draft).toBe("");
    expect(second.getSnapshot().pendingQuestion).toBeNull();
    response.resolve(answer);
    await running;
    expect(second.getSnapshot().messages).toEqual([]);
    expect(second.getSnapshot().context).toBeNull();
  });

  it("Clear invalidates late completion without interfering with the new request", async () => {
    const store = createHelpConversation();
    const old = deferred<HelpAskResult>();
    const next = deferred<HelpAskResult>();
    store.setDraft("Old question");
    const oldRun = store.send(() => old.promise);
    store.clear();
    store.setDraft("New question");
    const nextRun = store.send(() => next.promise);
    old.resolve({ ...answer, answer: "Stale response" });
    await oldRun;
    expect(store.getSnapshot().messages).toEqual([]);
    expect(store.getSnapshot().pendingQuestion).toBe("New question");
    next.resolve(answer);
    await nextRun;
    expect(store.getSnapshot().messages.map((message) => message.content)).toEqual([
      "New question",
      answer.answer,
    ]);
  });

  it("an explicit authorization failure clears context and history instead of retaining protected input", async () => {
    const store = createHelpConversation();
    store.setContext(context);
    store.setDraft("Earlier protected question");
    await store.send(async () => answer);
    store.setDraft("Protected request denied");
    await store.send(async () => {
      throw { _tag: "EnvironmentAuthorizationError", message: "private cause" };
    });
    expect(store.getSnapshot()).toMatchObject({
      messages: [],
      context: null,
      draft: "",
      pendingQuestion: null,
      accessDenied: true,
    });
    store.clear();
    const ask = vi.fn(async () => answer);
    store.setDraft("No bypass through Clear");
    await store.send(ask);
    expect(ask).not.toHaveBeenCalled();
    store.setContext(context);
    store.setDraft("New authorized question");
    await store.send(ask);
    expect(store.getSnapshot().messages).toHaveLength(2);
  });
});

describe("Help input and output boundaries", () => {
  it.each([
    [{ key: "Enter", shiftKey: false, isComposing: false }, true],
    [{ key: "Enter", shiftKey: true, isComposing: false }, false],
    [{ key: "Enter", shiftKey: false, isComposing: true }, false],
    [{ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }, false],
    [{ key: "a", shiftKey: false, isComposing: false }, false],
  ])("handles composer key %j", (event, expected) => {
    expect(shouldSubmitHelpComposer(event)).toBe(expected);
  });

  it("only exposes fixed Help error messages", () => {
    expect(helpFailureMessage({ _tag: "HelpError", code: "timeout", message: "secret" })).toContain(
      "too long",
    );
    for (const error of [
      new Error("credential"),
      { _tag: "HelpError", code: "unknown", message: "credential" },
      { _tag: "Other", code: "timeout" },
    ]) {
      expect(helpFailureMessage(error)).not.toContain("credential");
      expect(helpFailureMessage(error)).toContain("Your question is kept");
    }
  });

  it("only permits exact app settings destinations and the manual public issue tracker", () => {
    expect(resolveHelpLink("/settings/providers")).toEqual({
      kind: "internal",
      to: "/settings/providers",
      hash: "",
    });
    expect(resolveHelpLink("/settings/general#computer-use")).toEqual({
      kind: "internal",
      to: "/settings/general",
      hash: "computer-use",
    });
    expect(resolveHelpLink("/settings/appearance")).toEqual({
      kind: "internal",
      to: "/settings/appearance",
      hash: "",
    });
    for (const to of ["/settings/plugins", "/settings/skills", "/settings/scheduled-tasks"]) {
      expect(resolveHelpLink(to)).toEqual({ kind: "internal", to, hash: "" });
    }
    expect(resolveHelpLink("/settings/storage#storage-worktrees")).toEqual({
      kind: "internal",
      to: "/settings/storage",
      hash: "storage-worktrees",
    });
    expect(resolveHelpLink("/settings/keybindings#keybinding-sidebar.toggle")).toEqual({
      kind: "internal",
      to: "/settings/keybindings",
      hash: "keybinding-sidebar.toggle",
    });
    expect(resolveHelpLink("/settings/keybindings#keybindings")).toEqual({
      kind: "internal",
      to: "/settings/keybindings",
      hash: "keybindings",
    });
    expect(resolveHelpLink("/settings/source-control#source-control-host-bitbucket")).toEqual({
      kind: "internal",
      to: "/settings/source-control",
      hash: "source-control-host-bitbucket",
    });
    expect(resolveHelpLink(HELP_ISSUE_TRACKER_URL)).toEqual({
      kind: "external",
      href: HELP_ISSUE_TRACKER_URL,
    });
    for (const href of [
      "/settings/providers?token=secret",
      "/settings/providers#secret",
      "/settings/providers#computer-use",
      "/settings/storage#storage-worktree-keep-when",
      "/settings/keybindings#keybinding-rightPanel.toggleMaximized",
      "/settings/providers#",
      "/settings/general#computer-use#secret",
      "/settings/general#computer-use?token=secret",
      "/settings/not-registered",
      "/settings/plugins#unknown",
      "/settings/skills#unknown",
      "/settings/scheduled-tasks#unknown",
      "/settings/providers/",
      "//evil.test",
      "javascript:alert(1)",
      "file:///Users/private",
      "https://evil.test/report?private=secret",
      `${HELP_ISSUE_TRACKER_URL}?body=secret`,
      `${HELP_ISSUE_TRACKER_URL}#secret`,
      `${HELP_ISSUE_TRACKER_URL}/`,
      "data:image/png;base64,x",
      undefined,
    ]) {
      expect(resolveHelpLink(href)).toBeNull();
    }
  });
});
