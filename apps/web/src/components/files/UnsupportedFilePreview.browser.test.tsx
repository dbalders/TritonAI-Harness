import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UnsupportedFilePreview } from "./UnsupportedFilePreview";

const state = vi.hoisted(() => ({
  mode: "local-exec",
  resolved: true,
  shellAllowed: true,
  readAllowed: true,
  canOpenDefault: true,
  revealLabel: "Reveal in Finder",
  activate: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => state.shellAllowed,
}));
vi.mock("~/state/shell", () => ({
  shellEnvironment: { openInEditor: { permissionAtom: () => null } },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.activate }));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: state.readAllowed }),
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ isResolved: state.resolved, state: { mode: state.mode } }),
}));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({
    capabilities: { canOpenDefault: state.canOpenDefault, revealLabel: state.revealLabel },
    activate: state.activate,
  }),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlRefresh: (environmentId: string, resource: unknown) => () =>
    state.prepare(environmentId, resource),
}));

const environmentId = EnvironmentId.make("file-host");
const threadRef = { environmentId, threadId: ThreadId.make("file-thread") };
const props = {
  environmentId,
  threadRef,
  cwd: "/repo",
  absolutePath: "/repo/deck.pptx",
  relativePath: "deck.pptx",
  draft: false,
};

function setup() {
  state.mode = "local-exec";
  state.resolved = true;
  state.shellAllowed = true;
  state.readAllowed = true;
  state.canOpenDefault = true;
  state.revealLabel = "Reveal in Finder";
  state.activate.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.prepare.mockReset().mockResolvedValue("https://host.test/api/assets/signed/deck.pptx");
}

it("uses the same fallback for office files, archives and unknown binary formats", async () => {
  setup();
  await using screen = await render(<UnsupportedFilePreview {...props} />);
  for (const name of ["deck.pptx", "report.docx", "workbook.xlsx", "archive.zip", "data.unknown"]) {
    await screen.rerender(
      <UnsupportedFilePreview {...props} relativePath={name} absolutePath={`/repo/${name}`} />,
    );
    await expect
      .element(screen.getByText("This file can’t be previewed in Harness."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Open in default app" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Show in Finder" })).toBeVisible();
  }
  state.revealLabel = "Reveal in File Explorer";
  await screen.rerender(<UnsupportedFilePreview {...props} />);
  await expect.element(screen.getByRole("button", { name: "Show in File Explorer" })).toBeVisible();
});

it("prevents duplicate local launches and switches to download when shell access is lost", async () => {
  setup();
  let finish!: () => void;
  state.activate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(AsyncResult.success(undefined));
      }),
  );
  await using screen = await render(<UnsupportedFilePreview {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Open in default app" }));
  await expect.element(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Show in Finder" })).toBeDisabled();
  expect(state.activate).toHaveBeenCalledOnce();
  finish();
  await expect.element(screen.getByRole("button", { name: "Open in default app" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
  expect(state.activate).toHaveBeenLastCalledWith({
    environmentId,
    input: { cwd: "/repo/deck.pptx", editor: "file-manager", reveal: true },
  });
  state.shellAllowed = false;
  await screen.rerender(<UnsupportedFilePreview {...props} />);
  await expect
    .element(screen.getByRole("button", { name: "Open in default app" }))
    .not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Download" })).toBeVisible();
});

it("opens absolute host-file links and reports a failed OS launch", async () => {
  setup();
  await using screen = await render(
    <UnsupportedFilePreview
      {...props}
      relativePath="/tmp/report.zip"
      absolutePath="/tmp/report.zip"
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open in default app" }));
  expect(state.activate).toHaveBeenCalledWith({
    environmentId,
    input: { cwd: "/tmp/report.zip", editor: "file-manager" },
  });
  state.activate.mockRejectedValueOnce(new Error("No app is available to open this file."));
  await userEvent.click(screen.getByRole("button", { name: "Open in default app" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("No app is available to open this file.");
});

it.each(["remote-links", "remote-unavailable"])(
  "downloads original bytes without launching on a %s host",
  async (mode) => {
    setup();
    state.mode = mode;
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 255]);
    await using screen = await render(<UnsupportedFilePreview {...props} />);
    using _fetch = vi
      .spyOn(window, "fetch")
      .mockResolvedValue(
        new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
      );
    let downloaded: Blob | undefined;
    using _url = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      downloaded = blob as Blob;
      return "blob:test-download";
    });
    let downloadedName: string | undefined;
    using click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedName = this.download;
    });
    await expect
      .element(screen.getByRole("button", { name: "Open in default app" }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(new Uint8Array(await downloaded!.arrayBuffer())).toEqual(bytes);
    expect(downloadedName).toBe("deck.pptx");
    expect(state.prepare).toHaveBeenCalledWith(environmentId, {
      _tag: "workspace-file",
      threadId: threadRef.threadId,
      path: "/repo/deck.pptx",
      disposition: "attachment",
    });
    expect(state.activate).not.toHaveBeenCalled();
  },
);

it("allows retry after download failure and blocks actions without file access", async () => {
  setup();
  state.mode = "remote-unavailable";
  state.prepare.mockRejectedValueOnce(new Error("The file is unavailable. Try again."));
  await using screen = await render(<UnsupportedFilePreview {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "Download" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The file is unavailable. Try again.");
  await expect.element(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  state.readAllowed = false;
  await screen.rerender(<UnsupportedFilePreview {...props} />);
  await expect.element(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  expect(state.prepare).toHaveBeenCalledOnce();
});
