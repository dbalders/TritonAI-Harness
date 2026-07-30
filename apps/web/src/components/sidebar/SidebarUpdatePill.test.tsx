import type { DesktopUpdateState, InstallerUpdateState } from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  desktopUpdate: null as DesktopUpdateState | null,
  installerUpdate: null as InstallerUpdateState | null,
  sidebarV2Enabled: true,
  openInstallerUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  toast: vi.fn(),
}));

const hooks = vi.hoisted(() => ({
  useCallback<T>(callback: T): T {
    return callback;
  },
  useMemoCache(size: number): unknown[] {
    return Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
  },
  useState<T>(initialValue: T | (() => T)): [T, (nextValue: T) => void] {
    return [
      typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
      vi.fn(),
    ];
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: { readonly sidebarV2Enabled: boolean }) => unknown,
  ): unknown => select({ sidebarV2Enabled: testState.sidebarV2Enabled }),
}));
vi.mock("../../state/desktopUpdate", () => ({
  useDesktopUpdateState: () => testState.desktopUpdate,
}));
vi.mock("../../state/installerUpdate", () => ({
  useInstallerUpdateState: () => testState.installerUpdate,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testState.toast },
}));

import { SidebarUpdatePill } from "./SidebarUpdatePill";

const desktopUpdateBase: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const installerUpdateBase: InstallerUpdateState = {
  enabled: true,
  status: "idle",
  installedVersion: "1.0.0",
  availableVersion: null,
  markerStatus: "valid",
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (!isValidElement(node)) return "";
  return nodeText((node.props as { readonly children?: ReactNode }).children);
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (predicate(node)) return node;
  const props = node.props as {
    readonly children?: ReactNode;
    readonly render?: ReactNode;
  };
  return findElement(props.children, predicate) ?? findElement(props.render, predicate);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("SidebarUpdatePill", () => {
  beforeEach(() => {
    testState.desktopUpdate = null;
    testState.installerUpdate = null;
    testState.sidebarV2Enabled = true;
    testState.openInstallerUpdate.mockReset();
    testState.downloadUpdate.mockReset();
    testState.installUpdate.mockReset();
    testState.toast.mockReset();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          openInstallerUpdate: testState.openInstallerUpdate,
          downloadUpdate: testState.downloadUpdate,
          installUpdate: testState.installUpdate,
        },
      },
    });
  });

  it("renders the native-build warning in the shared Sidebar V2 footer", () => {
    testState.desktopUpdate = {
      ...desktopUpdateBase,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    const output = SidebarUpdatePill();

    expect(nodeText(output)).toContain("Intel build on Apple Silicon");
    expect(nodeText(output)).toContain("Run the next full TritonAI Installer update");
  });

  it("leaves Sidebar V1's existing architecture warning as the only copy", () => {
    testState.sidebarV2Enabled = false;
    testState.desktopUpdate = {
      ...desktopUpdateBase,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(SidebarUpdatePill()).toBeNull();
  });

  it("opens the full Installer for an available product update", async () => {
    const availableState = {
      ...installerUpdateBase,
      status: "available",
      availableVersion: "1.1.0",
    } as const;
    testState.installerUpdate = availableState;
    testState.openInstallerUpdate.mockResolvedValue({
      accepted: true,
      completed: true,
      state: availableState,
    });

    const output = SidebarUpdatePill();
    const updateButton = findElement(
      output,
      (element) =>
        element.type === "button" &&
        String((element.props as { readonly className?: string }).className).includes(
          "update-main",
        ),
    );

    expect(updateButton).not.toBeNull();
    if (!updateButton) throw new Error("Expected the Installer update button.");
    (updateButton.props as { readonly onClick: () => void }).onClick();
    await flushPromises();

    expect(testState.openInstallerUpdate).toHaveBeenCalledOnce();
    expect(testState.downloadUpdate).not.toHaveBeenCalled();
    expect(testState.installUpdate).not.toHaveBeenCalled();
  });
});
