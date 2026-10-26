import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { AssetUrlState } from "~/assets/assetUrls";
import { renewalVideoBase64 } from "../../../test/fixtures/signed-url-renewal";
import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<string | null>>(),
  assetUrl: null as Atom.Writable<AssetUrlState> | null,
}));
const { refresh } = state;

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
  useAssetUrlState: () => useAtomValue(state.assetUrl!),
}));
// The real source view highlights through a worker pool; the text it receives is what matters here.
// Never load the original: its highlighter graph can outlast waitFor on a cold CI browser.
vi.mock(import("./ReadOnlySourcePreview"), () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

import { AttachmentFilePreview } from "./AttachmentFilePreview";

describe("attachment HTML preview recovery", () => {
  const originalUrl = "data:text/html,original";
  const renewedUrl = "data:text/html,renewed";

  function setup() {
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
    state.assetUrl = Atom.make<AssetUrlState>({ _tag: "Loading" });
  }

  const openRemote = () =>
    render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
      />,
    );

  const toggleMode = async (screen: Screen, label: string) => {
    const button = screen.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = (screen: Screen) => screen.container.querySelector('[role="alert"]');

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode(screen, "Show HTML source");
    await act(async () => {
      await import("./ReadOnlySourcePreview");
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
    );

    await toggleMode(screen, "Show rendered page");
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode(screen, "Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(alert(screen)?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode(screen, "Show rendered page");
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await using screen = await render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={file.size}
        file={file}
      />,
    );
    await toggleMode(screen, "Show HTML source");
    await vi.waitFor(() => expect(alert(screen)?.textContent).toContain("not UTF-8"));

    await toggleMode(screen, "Show rendered page");
    expect(alert(screen)).toBeNull();
    expect(screen.container.querySelector("iframe")?.title).toBe("document.html");
  });

  it("reauthorizes before rendering after a long source-reading session", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    await toggleMode(screen, "Show HTML source");
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    now = 121_000;
    let completeRenewal!: (value: string | null) => void;
    const renewing = new Promise<string | null>((resolve) => {
      completeRenewal = resolve;
    });
    refresh.mockReturnValueOnce(renewing);
    await toggleMode(screen, "Show rendered page");
    expect(screen.container.querySelector("iframe")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(() => completeRenewal(renewedUrl));
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("holds an attachment video source until an expired request needs a newer capability", async () => {
  state.refresh.mockReset();
  const bytes = Uint8Array.from(atob(renewalVideoBase64), (value) => value.charCodeAt(0));
  const urls = [0, 1, 2].map(() => URL.createObjectURL(new Blob([bytes], { type: "video/webm" })));
  using _urls = { [Symbol.dispose]: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
  state.assetUrl = Atom.make<AssetUrlState>({
    _tag: "Success",
    url: urls[0]!,
    expiresAt: Date.now() + 120_000,
  });
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext value={registry}>
      <AttachmentFilePreview
        name="renewal.webm"
        mimeType="video/webm"
        sizeBytes={bytes.length}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "video" }}
      />
    </RegistryContext>,
  );
  const video = screen.container.querySelector("video")!;
  if (video.readyState < 1)
    await new Promise<void>((resolve) =>
      video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
    );
  await screen.getByLabelText("renewal.webm").click();
  await video.play();
  video.pause();
  for (const url of urls.slice(1)) {
    video.currentTime = 7;
    if (video.seeking)
      await new Promise<void>((resolve) =>
        video.addEventListener("seeked", () => resolve(), { once: true }),
      );
    const metadata = new Promise<void>((resolve) =>
      video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
    );
    await act(() =>
      registry.set(state.assetUrl!, { _tag: "Success", url, expiresAt: Date.now() + 120_000 }),
    );
    expect(video.src).not.toBe(url);
    video.dispatchEvent(new Event("error"));
    await metadata;
    if (video.seeking)
      await new Promise<void>((resolve) =>
        video.addEventListener("seeked", () => resolve(), { once: true }),
      );
    expect(video.src).toBe(url);
    expect(video.currentTime).toBeCloseTo(7, 0);
    expect(video.paused).toBe(true);
  }
  expect(state.refresh).not.toHaveBeenCalled();
});
