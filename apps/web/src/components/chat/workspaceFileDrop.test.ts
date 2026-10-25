import { vi } from "@effect/vitest";
import { makeWorkspaceFileDropHandlers } from "./workspaceFileDrop";
import { type WorkspaceFileDragEvent } from "./workspaceFileDrop";
import { type WorkspaceFileDropHost } from "./workspaceFileDrop";
import { describe, expect, it } from "@effect/vitest";
import { splitTransferredFiles } from "./workspaceFileDrop";

describe("splitTransferredFiles", () => {
  it("separates copied folders from files before attachment validation", () => {
    const folder = new File([], "photos.png");
    const emptyFile = new File([], "empty.txt");
    const image = new File(["image"], "photo.png", { type: "image/png" });

    expect(
      splitTransferredFiles({
        files: [folder, emptyFile, image],
        items: [
          {
            kind: "string",
            getAsFile: () => null,
            webkitGetAsEntry: () => null,
          },
          {
            kind: "file",
            getAsFile: () => folder,
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
          {
            kind: "file",
            getAsFile: () => emptyFile,
            webkitGetAsEntry: () => ({ isDirectory: false }),
          },
          {
            kind: "file",
            getAsFile: () => image,
            webkitGetAsEntry: () => null,
          },
        ],
      }),
    ).toEqual({ files: [emptyFile, image], folders: [folder] });
  });

  it("ignores clipboard file items that cannot provide a file", () => {
    expect(
      splitTransferredFiles({
        files: [],
        items: [
          {
            kind: "file",
            getAsFile: () => null,
            webkitGetAsEntry: () => ({ isDirectory: true }),
          },
        ],
      }),
    ).toEqual({ files: [], folders: [] });
  });
});

function makeDragEvent(options?: {
  types?: string[];
  files?: File[];
  items?: NonNullable<WorkspaceFileDragEvent["dataTransfer"]["items"]>;
  movedWithinTarget?: boolean;
}) {
  const preventDefault = vi.fn();
  const event = {
    dataTransfer: {
      types: options?.types ?? ["Files"],
      files: options?.files ?? [],
      dropEffect: "none",
      ...(options?.items === undefined ? {} : { items: options.items }),
    },
    relatedTarget: options?.movedWithinTarget ? ({} as EventTarget) : null,
    currentTarget: {
      contains: () => options?.movedWithinTarget ?? false,
    },
    preventDefault,
  } satisfies WorkspaceFileDragEvent;
  return { event, preventDefault };
}
function makeHost() {
  const setDragActive = vi.fn();
  const addFiles = vi.fn();
  const addFolders = vi.fn();
  const host = { setDragActive, addFiles, addFolders } satisfies WorkspaceFileDropHost;
  return { host, setDragActive, addFiles, addFolders };
}
describe("makeWorkspaceFileDropHandlers", () => {
  it("adds dropped images and generic files and clears the active state", () => {
    const image = new File(["image"], "example.png", { type: "image/png" });
    const document = new File(["document"], "example.txt", { type: "text/plain" });
    const { host, setDragActive, addFiles, addFolders } = makeHost();
    const { event } = makeDragEvent({ files: [image, document] });

    makeWorkspaceFileDropHandlers(host).onDrop(event);

    expect(setDragActive).toHaveBeenCalledWith(false);
    expect(addFiles).toHaveBeenCalledWith([image, document]);
    expect(addFolders).not.toHaveBeenCalled();
  });
});
