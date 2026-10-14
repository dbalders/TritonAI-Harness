import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The same environment ChatMarkdown's own tests render it in.
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import { BotReplyMarkdown } from "./BotReplyMarkdown";

describe("BotReplyMarkdown", () => {
  it("loads no image a quoted email plants, whether as raw HTML or Markdown", () => {
    const html = renderToStaticMarkup(
      <BotReplyMarkdown
        text={
          'Summary <img src="https://tracker.example/open?id=1"> and ![chart](https://tracker.example/c.png)\n\n<p><img src="https://tracker.example/p.gif"></p>'
        }
      />,
    );
    expect(html).not.toMatch(/<img[^>]+tracker\.example/);
    expect(html).not.toMatch(/<(img|video|source)\b[^>]*src=/);
    // Raw HTML shows as its text; the Markdown image is a link the owner can choose to open.
    expect(html).toContain("&lt;img src=&quot;https://tracker.example/open?id=1&quot;&gt;");
    expect(html).toContain('href="https://tracker.example/c.png"');
  });

  it("still renders the reply's own formatting", () => {
    const html = renderToStaticMarkup(
      <BotReplyMarkdown text={"**Still ahead:**\n1. Pickup at 2:00 PM\n2. Call Jane"} />,
    );
    expect(html).toContain("<strong>Still ahead:</strong>");
    expect(html).toMatch(/<ol[^>]*>[\s\S]*Pickup at 2:00 PM[\s\S]*<\/ol>/);
  });
});
