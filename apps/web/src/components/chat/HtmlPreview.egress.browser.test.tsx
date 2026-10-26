import { expect, it, vi } from "vite-plus/test";

import { page } from "vite-plus/test/browser";

import { htmlRenderTheme, HTML_RENDER_DEFAULT_FONTS } from "@t3tools/shared/htmlRender";

import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import "~/index.css";

import { act, render as renderUi } from "../../../test/render";

import { HtmlRenderFrame } from "./HtmlRenderFrame";

const { cachedUrl, refresh, showError, openLink, openChangeRequestLink } = vi.hoisted(() => ({
  cachedUrl: { lifeMs: 60 * 60_000 },
  refresh: vi.fn(),
  showError: vi.fn(),
  openLink: vi.fn(),
  openChangeRequestLink: vi.fn(),
}));

vi.mock(import("~/browser/useOpenLink"), async (original) => ({
  ...(await original()),
  useOpenLink: () => openLink,
}));

vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  useOpenChangeRequestLink: () => openChangeRequestLink,
}));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "about:blank",
    expiresAt: Date.now() + cachedUrl.lifeMs,
  }),
  useAssetUrlRefresh: () => refresh,
}));

vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: showError } };
});

vi.mock(import("~/hooks/useHtmlRenderTheme"), async (original) => ({
  ...(await original()),
  useHtmlRenderTheme: () =>
    htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_DEFAULT_FONTS),
}));

function setup() {
  refresh.mockReset();
  cachedUrl.lifeMs = 60 * 60_000;
  openLink.mockReset().mockResolvedValue(undefined);
  openChangeRequestLink.mockReset().mockReturnValue(false);
  showError.mockClear();
}

function button(label: string) {
  return page.getByRole("button", { name: label, exact: true });
}

// A trusted click, so the page also gets the user activation the link handler requires.
async function click(label: string) {
  await button(label).click();
}

async function renderInline() {
  return renderUi(
    <HtmlRenderFrame
      environmentId={EnvironmentId.make("environment")}
      htmlRender={{ attachmentId: "html", title: "Diagram", height: 400 }}
      threadRef={{
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
      }}
    />,
  );
}

it("does not let an expanded preview open external links through the host", async () => {
  setup();
  await using _screen = await renderInline();
  openChangeRequestLink.mockReturnValue(true);
  await click("Open full screen");
  const frame = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!;
  frame.focus();
  const url = "https://github.com/pingdotgg/t3code/pull/17561";
  await act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { jsonrpc: "2.0", id: "link", method: "ui/open-link", params: { url } },
      }),
    );
  });
  expect(openChangeRequestLink).not.toHaveBeenCalled();
  expect(openLink).not.toHaveBeenCalled();
});
