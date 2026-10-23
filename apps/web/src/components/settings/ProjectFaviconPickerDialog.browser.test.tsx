import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type AssetCreateUrlResult, type ProjectEntry } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { act, render, stubGlobal } from "../../../test/render";

type AssetResult = AsyncResult.AsyncResult<AssetCreateUrlResult, Error>;
const state = vi.hoisted(() => ({
  entries: [] as ProjectEntry[],
  assets: new Map<string, Atom.Writable<AssetResult>>(),
  canReadFiles: true,
  createUrl: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock(import("~/state/assets"), async (original) => ({
  ...(await original()),
  assetEnvironment: { createUrl: state.createUrl, createUrls: vi.fn() },
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: () =>
    ({
      _tag: "Some" as const,
      value: { httpBaseUrl: location.origin },
    }) as ReturnType<typeof import("~/state/session").usePreparedConnection>,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({
    canReadFiles: state.canReadFiles,
    isPending: false,
    error: null,
  }),
}));
vi.mock(import("../files/projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFilePickerQuery: () => ({
    entries: state.entries,
    error: null,
    isPending: false,
    matchedQuery: "",
  }),
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toast } };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";

import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";

function setup() {
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  toast.mockClear();
  state.entries = [];
  state.assets.clear();
  state.canReadFiles = true;
  state.createUrl
    .mockReset()
    .mockImplementation(({ input }) => state.assets.get(input.resource.path)!);
  return { [Symbol.dispose]: () => platform.mockRestore() };
}

async function renderPicker(onPickExternal?: () => Promise<string | null>) {
  const onOpenChange = vi.fn();
  const onSelect = vi.fn();
  const screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <ProjectFaviconPickerDialog
        cwd="/Users/me/project"
        environmentId={EnvironmentId.make("local")}
        onOpenChange={onOpenChange}
        {...(onPickExternal ? { onPickExternal } : {})}
        onSelect={onSelect}
        open
        projectName="Project"
      />
    </RegistryContext.Provider>,
  );
  return Object.assign(screen, { onOpenChange, onSelect });
}
async function clickOpenInFinder() {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("Open in Finder"),
  );
  expect(button, "Open in Finder").toBeDefined();
  await act(async () => button!.click());
}

it("selects an image from the native file picker", async () => {
  using _env = setup();
  const onPickExternal = vi.fn().mockResolvedValue("/Users/me/Pictures/icon.png");
  await using screen = await renderPicker(onPickExternal);

  await clickOpenInFinder();

  expect(onPickExternal).toHaveBeenCalledTimes(1);
  expect(screen.onOpenChange).toHaveBeenCalledWith(false);
  expect(screen.onSelect).toHaveBeenCalledWith("/Users/me/Pictures/icon.png");
});

it("hides the native picker for WSL project paths", () => {
  expect(canPickExternalProjectFavicon("/home/me/project", "Win32")).toBe(false);
  expect(canPickExternalProjectFavicon("C:\\Users\\me\\project", "Win32")).toBe(true);
});

it("keeps the dialog open when the native picker fails", async () => {
  using _env = setup();
  await using screen = await renderPicker(vi.fn().mockRejectedValue(new Error("picker failed")));

  await clickOpenInFinder();

  expect(screen.onOpenChange).not.toHaveBeenCalled();
  expect(screen.onSelect).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith({
    type: "error",
    title: "Could not open image picker",
    description: "picker failed",
  });
});

const imageUrl = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
)}`;

function addFiles(paths: string[]) {
  state.entries = paths.map((path) => ({ path, kind: "file" }));
  for (const path of paths) state.assets.set(path, Atom.make<AssetResult>(AsyncResult.initial()));
}

function fileRow(path: string) {
  const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
    element.textContent?.includes(path),
  );
  expect(row, path).toBeDefined();
  return row!;
}

async function publishUrl(path: string, url: string) {
  faviconFailure?.snapshot(`publish-before:${path}`);
  await act(async () => {
    faviconFailure?.snapshot(`set-before:${path}`);
    appAtomRegistry.set(
      state.assets.get(path)!,
      AsyncResult.success({ relativeUrl: url, expiresAt: Date.now() + 60_000 }),
    );
    faviconFailure?.snapshot(`set-after:${path}`);
  });
  faviconFailure?.snapshot(`publish-after:${path}`);
}

// Decoding sets naturalWidth before the load event reaches React, so wait for both together.
async function expectPreview(row: HTMLElement) {
  await expect
    .poll(() => ({
      width: row.querySelector("img")?.naturalWidth,
      fallback: row.querySelector("svg") !== null,
    }))
    .toEqual({ width: 8, fallback: false });
}

// Failure-only output; observation never reads/creates/subscribes an atom node.
function observeFaviconFailure() {
  const paths = ["icons/icon-0.svg", "icons/icon-39.svg"];
  const started = performance.now();
  const history: object[] = [];
  const saved = new Map<string, HTMLElement>();
  const identities = new WeakMap<object, number>();
  let nextId = 0;
  let dropped = 0;
  let observerErrors = 0;
  const id = (value: object) => {
    let current = identities.get(value);
    if (current === undefined) identities.set(value, (current = ++nextId));
    return current;
  };
  const safely = (run: () => void) => {
    try {
      run();
    } catch {
      observerErrors++;
    }
  };
  const record = (type: string, fields: object) => {
    if (history.length < 128) history.push({ ms: performance.now() - started, type, ...fields });
    else dropped++;
  };
  const currentRow = (path: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes(path),
    ) ?? null;
  const imageInfo = (image: HTMLImageElement | null) =>
    image && {
      id: id(image),
      connected: image.isConnected,
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
      srcMatchesFixture: image.getAttribute("src") === imageUrl,
      currentSrcMatchesFixture: image.currentSrc === imageUrl,
    };
  const rowInfo = (row: HTMLElement | null | undefined) =>
    row
      ? {
          id: id(row),
          connected: row.isConnected,
          fallback: row.querySelector("svg") !== null,
          image: imageInfo(row.querySelector("img")),
        }
      : null;
  type RegistryNode =
    ReturnType<typeof appAtomRegistry.getNodes> extends ReadonlyMap<unknown, infer N> ? N : never;
  const nodeInfo = (node: RegistryNode | undefined) => {
    if (!node) return null;
    // Both functions return stored state without rebuilding or keeping the node alive.
    const option = node.valueOption();
    const result = option._tag === "Some" ? (option.value as AssetResult) : null;
    return {
      id: id(node),
      lifecycle: node.currentState(),
      removable: node.canBeRemoved,
      listeners: node.listeners.size,
      children: node.children.size,
      parents: node.parents.size,
      resultTag: result?._tag ?? null,
      waiting: result?.waiting ?? null,
      urlMatchesFixture: result?._tag === "Success" ? result.value.relativeUrl === imageUrl : null,
    };
  };
  const snapshot = (label: string) =>
    safely(() => {
      const nodes = appAtomRegistry.getNodes();
      record("checkpoint", {
        label,
        rows: paths.map((path) => {
          const atom = state.assets.get(path);
          const current = currentRow(path);
          return {
            path,
            saved: rowInfo(saved.get(path)),
            current: rowInfo(current),
            savedIsCurrent: saved.has(path) ? saved.get(path) === current : null,
            atomId: atom ? id(atom) : null,
            keepAlive: atom?.keepAlive ?? null,
            idleTTL: atom?.idleTTL ?? null,
            node: atom ? nodeInfo(nodes.get(atom)) : null,
          };
        }),
      });
    });
  const imageEvent = (event: Event) =>
    safely(() => {
      if (!(event.target instanceof HTMLImageElement)) return;
      const row = event.target.closest<HTMLElement>('[role="option"]');
      const path = paths.find((path) => row?.textContent?.includes(path));
      if (path)
        record("native-image", {
          path,
          event: event.type,
          trusted: event.isTrusted,
          row: rowInfo(row),
          image: imageInfo(event.target),
        });
    });
  // Proposed passive capture only: no preventDefault/propagation changes or synthetic events.
  safely(() => document.addEventListener("load", imageEvent, { capture: true, passive: true }));
  safely(() => document.addEventListener("error", imageEvent, { capture: true, passive: true }));
  const added = appAtomRegistry.onNodeAdded;
  const removed = appAtomRegistry.onNodeRemoved;
  const nodeEvent = (type: string, node: RegistryNode) =>
    safely(() => {
      const path = paths.find((path) => state.assets.get(path) === node.atom);
      if (path) record(type, { path, node: nodeInfo(node) });
    });
  appAtomRegistry.onNodeAdded = function (node) {
    nodeEvent("node-added", node);
    return added?.call(this, node);
  };
  appAtomRegistry.onNodeRemoved = function (node) {
    nodeEvent("node-removed", node);
    return removed?.call(this, node);
  };
  snapshot("attached-after-render");
  return {
    snapshot,
    remember(path: string, row: HTMLElement) {
      saved.set(path, row);
    },
    failure(stage: string) {
      // A reporting error must never replace the caught assertion/original error.
      try {
        snapshot("failure-before-render-disposal");
        const acquisitions = state.createUrl.mock.calls.flatMap(([target], call) => {
          const path = target.input.resource.path as string;
          return paths.includes(path) ? [{ call, path }] : [];
        });
        console.error(
          "FAVICON_FAILURE_CONTEXT",
          JSON.stringify({
            stage,
            history,
            acquisitions: acquisitions.slice(-64),
            acquisitionCount: acquisitions.length,
            dropped,
            observerErrors,
            preRenderEventHistory: "not observed",
          }),
        );
      } catch {
        /* Preserve the original error even if diagnostics fail. */
      }
    },
    dispose() {
      safely(() => document.removeEventListener("load", imageEvent, true));
      safely(() => document.removeEventListener("error", imageEvent, true));
      safely(() => {
        appAtomRegistry.onNodeAdded = added;
      });
      safely(() => {
        appAtomRegistry.onNodeRemoved = removed;
      });
    },
  };
}
let faviconFailure: ReturnType<typeof observeFaviconFailure> | undefined;

it("loads previews asynchronously and only acquires offscreen images after scrolling", async () => {
  using _env = setup();
  const paths = Array.from({ length: 40 }, (_, index) => `icons/icon-${index}.svg`);
  addFiles(paths);
  await using screen = await renderPicker();
  const context = observeFaviconFailure();
  faviconFailure = context;
  let stage = "locate-rows";
  try {
    const first = fileRow("icons/icon-0.svg");
    const last = fileRow("icons/icon-39.svg");
    context.remember("icons/icon-0.svg", first);
    context.remember("icons/icon-39.svg", last);
    context.snapshot("rows-saved");
    stage = "initial-acquisition-and-offscreen-guards";

    await expect.poll(() => state.createUrl.mock.calls.length).toBeGreaterThan(0);
    expect(first.querySelector("img")).toBeNull();
    expect(first.querySelector("svg")).not.toBeNull();
    expect(last.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
    expect(
      state.createUrl.mock.calls.some(
        ([target]) => target.input.resource.path === "icons/icon-39.svg",
      ),
    ).toBe(false);

    stage = "publish-first";
    await publishUrl("icons/icon-0.svg", imageUrl);
    stage = "preview-first";
    await expectPreview(first);

    stage = "scroll-and-acquire-last";
    await act(async () => last.scrollIntoView({ block: "center" }));
    await expect
      .poll(() =>
        state.createUrl.mock.calls.some(
          ([target]) => target.input.resource.path === "icons/icon-39.svg",
        ),
      )
      .toBe(true);
    stage = "publish-last";
    await publishUrl("icons/icon-39.svg", imageUrl);
    stage = "preview-last";
    await expectPreview(last);
    stage = "select-last";
    await act(async () => last.click());
    expect(screen.onSelect).toHaveBeenCalledWith("icons/icon-39.svg");
  } catch (error) {
    context.failure(stage);
    throw error;
  } finally {
    faviconFailure = undefined;
    context.dispose();
  }
});

it("loads without IntersectionObserver and recovers a failed image when its URL changes", async () => {
  using _env = setup();
  using _observer = stubGlobal("IntersectionObserver", undefined);
  addFiles(["icons/logo.svg"]);
  await using _screen = await renderPicker();
  const row = fileRow("icons/logo.svg");

  expect(state.createUrl).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("local"),
    input: {
      resource: { _tag: "draft-workspace-file", cwd: "/Users/me/project", path: "icons/logo.svg" },
    },
  });
  expect(row.querySelector("svg")).not.toBeNull();
  await publishUrl("icons/logo.svg", imageUrl);
  await expectPreview(row);

  // Let Chromium reject the image bytes rather than dispatching a synthetic error.
  await publishUrl("icons/logo.svg", "data:image/png;base64,broken");
  await expect.poll(() => row.querySelector("img")).toBeNull();
  expect(row.querySelector("svg")).not.toBeNull();

  await publishUrl("icons/logo.svg", `${imageUrl}#renewed`);
  await expectPreview(row);
});

it("keeps denied previews selectable with their file icon", async () => {
  using _env = setup();
  using _observer = stubGlobal("IntersectionObserver", undefined);
  state.canReadFiles = false;
  addFiles(["icons/private.svg"]);
  await using screen = await renderPicker();
  const row = fileRow("icons/private.svg");

  await act(async () => row.click());
  expect(row.querySelector("img")).toBeNull();
  expect(row.querySelector("svg")).not.toBeNull();
  expect(state.createUrl).not.toHaveBeenCalled();
  expect(screen.onSelect).toHaveBeenCalledWith("icons/private.svg");
});

it("keeps the file icon until the image load is acknowledged", async () => {
  using _env = setup();
  using _observer = stubGlobal("IntersectionObserver", undefined);
  addFiles(["icons/loading.svg"]);
  await using _screen = await renderPicker();
  const row = fileRow("icons/loading.svg");
  // Hold the load notification so a fast data URL has the same UI state as a slow request.
  const holdLoad = (event: Event) => {
    if (event.target instanceof HTMLImageElement && row.contains(event.target)) {
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener("load", holdLoad, true);
  try {
    await publishUrl("icons/loading.svg", imageUrl);
    await expect.poll(() => row.querySelector("img")?.naturalWidth).toBe(8);
    expect(row.querySelector("svg")).not.toBeNull();
    document.removeEventListener("load", holdLoad, true);
    await publishUrl("icons/loading.svg", `${imageUrl}#loaded`);
    await expectPreview(row);
  } finally {
    document.removeEventListener("load", holdLoad, true);
  }
});
