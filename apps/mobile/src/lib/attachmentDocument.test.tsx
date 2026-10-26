import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("../state/assets", () => ({ useRefreshAssetUrl: () => mocks.refresh }));
vi.mock("expo/fetch", () => ({ fetch: mocks.fetch }));
vi.mock("expo-file-system", () => ({
  File: vi.fn(() => {
    throw new Error("Unexpected local file access in a remote document test");
  }),
}));
vi.mock("../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("./localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("./attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  shareLocalAttachment: vi.fn(),
}));

import { useAttachmentDocument } from "./attachmentDocument";

async function setup() {
  await using resources = new AsyncDisposableStack();
  mocks.refresh.mockReset();
  mocks.fetch.mockReset();
  let clock = 0;
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  resources.defer(() => now.mockRestore());
  const initial = "https://synthetic.invalid/initial";
  mocks.refresh.mockResolvedValue(initial);
  mocks.fetch.mockImplementation((url: string) =>
    Promise.resolve(
      url === initial && clock >= 120_000
        ? new Response("Expired", { status: 404 })
        : new Response("Fresh synthetic source", { status: 200 }),
    ),
  );
  let latest: ReturnType<typeof useAttachmentDocument> | undefined;
  const renderedUris: Array<string | null> = [];
  function Probe() {
    const document = useAttachmentDocument({
      name: "report.html",
      mimeType: "text/html",
      sizeBytes: 42,
      attachmentId: "synthetic-html",
      environmentId: EnvironmentId.make("synthetic-environment"),
      attachment: null,
    });
    useLayoutEffect(() => {
      latest = document;
      if (document.rendered) renderedUris.push(document.uri);
    }, [document]);
    return (
      <>
        <button onClick={() => document.setRendered(false)}>Source</button>
        <button onClick={() => document.setRendered(true)}>Preview</button>
        <p>{document.error ?? document.content?.text ?? "Loading"}</p>
      </>
    );
  }
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  resources.defer(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  resources.defer(async () => act(async () => root.unmount()));
  await act(async () => root.render(<Probe />));
  const cleanup = resources.move();
  return {
    container,
    renderedUris,
    document: () => latest!,
    setTime: (value: number) => (clock = value),
    click: async (name: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (element) => element.textContent === name,
      );
      if (!button) throw new Error(`Missing ${name} button`);
      await act(async () => button.click());
    },
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

it("reauthorizes Source after the initial HTML URL has expired", async () => {
  await using screen = await setup();
  screen.setTime(121_000);
  mocks.refresh.mockResolvedValue("https://synthetic.invalid/fresh-source");
  await screen.click("Source");
  expect(mocks.fetch).toHaveBeenCalledWith(
    "https://synthetic.invalid/fresh-source",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(screen.container.textContent).toContain("Fresh synthetic source");
  expect(screen.document().error).toBeNull();
});

it("clears the old preview before waiting for its new authorization", async () => {
  await using screen = await setup();
  await screen.click("Source");
  screen.setTime(121_000);
  const authorization = Promise.withResolvers<string>();
  mocks.refresh.mockReturnValue(authorization.promise);
  screen.renderedUris.length = 0;
  await screen.click("Preview");
  expect(screen.document().uri).toBeNull();
  expect(screen.renderedUris.every((uri) => uri === null)).toBe(true);
  await act(async () => authorization.resolve("https://synthetic.invalid/fresh-preview"));
  expect(screen.document().uri).toBe("https://synthetic.invalid/fresh-preview");
});

it("does not read a superseded Source authorization after switching back", async () => {
  await using screen = await setup();
  const sourceAuthorization = Promise.withResolvers<string>();
  mocks.refresh
    .mockReturnValueOnce(sourceAuthorization.promise)
    .mockResolvedValue("https://synthetic.invalid/current-preview");
  await screen.click("Source");
  await screen.click("Preview");
  await act(async () => sourceAuthorization.resolve("https://synthetic.invalid/old-source"));
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(screen.document().uri).toBe("https://synthetic.invalid/current-preview");
});
