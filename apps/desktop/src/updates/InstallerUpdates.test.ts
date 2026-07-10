import { describe, expect, it, vi } from "vite-plus/test";

import {
  compareInstallerVersions,
  createInstallerUpdateController,
  expectedInstallerAssetName,
  parseStableInstallerRelease,
  parseInstallerVersionMarker,
  selectInstallerReleaseAsset,
} from "./InstallerUpdates.ts";

function release(version: string, assets?: readonly Record<string, unknown>[]) {
  const normalized = version.replace(/^v/, "");
  return {
    draft: false,
    prerelease: false,
    tag_name: version,
    assets: assets ?? [
      {
        name: `TritonAI-Installer-${normalized}-arm64.dmg`,
        browser_download_url: `https://github.com/dbalders/TritonAI-Installer/releases/download/v${normalized}/TritonAI-Installer-${normalized}-arm64.dmg`,
      },
    ],
  };
}

describe("installer version comparison and release selection", () => {
  it("compares stable versions numerically", () => {
    expect(compareInstallerVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareInstallerVersions("v2.0.0", "2.0.0")).toBe(0);
    expect(compareInstallerVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(() => compareInstallerVersions("1.2.3-beta.1", "1.2.3")).toThrow();
  });

  it("accepts a stable release and rejects drafts and prereleases", () => {
    const selected = parseStableInstallerRelease(release("v1.5.0"));
    expect(selected.version).toBe("1.5.0");
    expect(() => parseStableInstallerRelease({ ...release("9.0.0"), draft: true })).toThrow();
    expect(() => parseStableInstallerRelease({ ...release("8.0.0"), prerelease: true })).toThrow();
  });

  it("selects only the exact full installer for each supported target", () => {
    const macRelease = parseStableInstallerRelease(release("1.5.0"));
    expect(selectInstallerReleaseAsset(macRelease, "darwin", "arm64").name).toBe(
      "TritonAI-Installer-1.5.0-arm64.dmg",
    );

    const windowsName = "TritonAI-Installer-Setup-1.5.0-x64.exe";
    const windowsRelease = parseStableInstallerRelease(
      release("1.5.0", [
        {
          name: "TritonAI-Installer-1.5.0-x64-portable.exe",
          browser_download_url:
            "https://github.com/dbalders/TritonAI-Installer/releases/download/v1.5.0/TritonAI-Installer-1.5.0-x64-portable.exe",
        },
        {
          name: `${windowsName}.blockmap`,
          browser_download_url: `https://github.com/dbalders/TritonAI-Installer/releases/download/v1.5.0/${windowsName}.blockmap`,
        },
        {
          name: windowsName,
          browser_download_url: `https://github.com/dbalders/TritonAI-Installer/releases/download/v1.5.0/${windowsName}`,
        },
      ]),
    );
    expect(selectInstallerReleaseAsset(windowsRelease, "win32", "x64").name).toBe(windowsName);
  });

  it("rejects unsupported targets, missing assets, and untrusted URLs", () => {
    expect(() => expectedInstallerAssetName("1.5.0", "linux", "x64")).toThrow(
      "not available for linux/x64",
    );
    const missing = parseStableInstallerRelease(release("1.5.0", []));
    expect(() => selectInstallerReleaseAsset(missing, "darwin", "arm64")).toThrow(
      "missing TritonAI-Installer-1.5.0-arm64.dmg",
    );
    const unsafe = parseStableInstallerRelease(
      release("1.5.0", [
        {
          name: "TritonAI-Installer-1.5.0-arm64.dmg",
          browser_download_url: "https://example.com/TritonAI-Installer-1.5.0-arm64.dmg",
        },
      ]),
    );
    expect(() => selectInstallerReleaseAsset(unsafe, "darwin", "arm64")).toThrow("missing");

    const wrongPlatform = parseStableInstallerRelease(
      release("1.5.0", [
        {
          name: "TritonAI-Installer-Setup-1.5.0-x64.exe",
          browser_download_url:
            "https://github.com/dbalders/TritonAI-Installer/releases/download/v1.5.0/TritonAI-Installer-Setup-1.5.0-x64.exe",
        },
      ]),
    );
    expect(() => selectInstallerReleaseAsset(wrongPlatform, "darwin", "arm64")).toThrow(
      "missing TritonAI-Installer-1.5.0-arm64.dmg",
    );

    for (const browser_download_url of [
      "https://github.com.evil.example/dbalders/TritonAI-Installer/releases/download/v1.5.0/TritonAI-Installer-1.5.0-arm64.dmg",
      "https://github.com/dbalders/TritonAI-Installer/releases/download/v1.5.0/TritonAI-Installer-1.5.0-arm64.dmg?redirect=evil",
      "https://github.com/dbalders/TritonAI-Installer/releases/download/v1.5.0/TritonAI-Installer-1.5.0-arm64.dmg%2F..%2Fevil.dmg",
    ]) {
      const malicious = parseStableInstallerRelease(
        release("1.5.0", [{ name: "TritonAI-Installer-1.5.0-arm64.dmg", browser_download_url }]),
      );
      expect(() => selectInstallerReleaseAsset(malicious, "darwin", "arm64")).toThrow("missing");
    }

    const legacy = parseStableInstallerRelease(
      release("1.5.0", [
        {
          name: "UCSD-AI-Tools-Installer-1.5.0-arm64.dmg",
          browser_download_url:
            "https://github.com/dbalders/TritonAI-Installer/releases/download/v1.5.0/UCSD-AI-Tools-Installer-1.5.0-arm64.dmg",
        },
      ]),
    );
    expect(() => selectInstallerReleaseAsset(legacy, "darwin", "arm64")).toThrow(
      "missing TritonAI-Installer-1.5.0-arm64.dmg",
    );
  });
});

describe("installer version marker", () => {
  it("treats a missing marker as a legacy install", () => {
    expect(parseInstallerVersionMarker(null)).toEqual({
      status: "missing",
      version: null,
    });
  });

  it("rejects corrupt and invalid marker content", () => {
    expect(parseInstallerVersionMarker("not-json")).toEqual({
      status: "corrupt",
      version: null,
    });

    expect(
      parseInstallerVersionMarker(
        JSON.stringify({ schemaVersion: 1, version: "1.2.3-beta.1", installedAt: "today" }),
      ),
    ).toEqual({
      status: "corrupt",
      version: null,
    });
  });

  it("reads a valid marker", () => {
    expect(
      parseInstallerVersionMarker(
        JSON.stringify({
          schemaVersion: 1,
          version: "1.2.3",
          installedAt: "2026-07-09T12:00:00.000Z",
        }),
      ),
    ).toEqual({
      status: "valid",
      version: "1.2.3",
    });
  });
});

describe("installer update controller", () => {
  it("offers the latest installer to a legacy installation and opens the exact asset", async () => {
    const openExternal = vi.fn(async () => true);
    const controller = createInstallerUpdateController({
      enabled: true,
      platform: "darwin",
      arch: "arm64",
      readMarker: async () => ({ status: "missing", version: null }),
      fetchRelease: async () => release("1.5.0"),
      openExternal,
      nowIso: () => "2026-07-09T12:00:00.000Z",
    });

    const check = await controller.check();
    expect(check.state.status).toBe("available");
    expect(check.state.markerStatus).toBe("missing");
    expect(check.state.availableVersion).toBe("1.5.0");

    const action = await controller.open();
    expect(action).toMatchObject({ accepted: true, completed: true });
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/dbalders/TritonAI-Installer/releases/download/v1.5.0/TritonAI-Installer-1.5.0-arm64.dmg",
    );
    expect(action.state.message).toContain("Harness, Codex, and managed skills");
  });

  it("reports current when the marker matches the latest installer", async () => {
    const controller = createInstallerUpdateController({
      enabled: true,
      platform: "darwin",
      arch: "arm64",
      readMarker: async () => ({ status: "valid", version: "1.5.0" }),
      fetchRelease: async () => release("1.5.0"),
      openExternal: async () => true,
    });
    expect((await controller.check()).state).toMatchObject({
      status: "up-to-date",
      installedVersion: "1.5.0",
      availableVersion: null,
    });
  });

  it("keeps check and open failures recoverable without throwing", async () => {
    const failingCheck = createInstallerUpdateController({
      enabled: true,
      platform: "darwin",
      arch: "arm64",
      readMarker: async () => ({ status: "missing", version: null }),
      fetchRelease: async () => {
        throw new Error("secret upstream detail");
      },
      openExternal: async () => true,
    });
    expect((await failingCheck.check()).state).toMatchObject({
      status: "error",
      errorContext: "check",
      canRetry: true,
    });
    expect((await failingCheck.check()).state.message).not.toContain("secret upstream detail");

    const failingOpen = createInstallerUpdateController({
      enabled: true,
      platform: "darwin",
      arch: "arm64",
      readMarker: async () => ({ status: "missing", version: null }),
      fetchRelease: async () => release("1.5.0"),
      openExternal: async () => false,
    });
    await failingOpen.check();
    expect(await failingOpen.open()).toMatchObject({
      accepted: true,
      completed: false,
      state: { status: "error", errorContext: "open", canRetry: true },
    });
  });

  it("does not query the network for an unsupported target", async () => {
    const fetchRelease = vi.fn(async () => release("1.5.0"));
    const controller = createInstallerUpdateController({
      enabled: true,
      platform: "darwin",
      arch: "x64",
      readMarker: async () => ({ status: "missing", version: null }),
      fetchRelease,
      openExternal: async () => true,
    });
    expect(controller.getState()).toMatchObject({
      enabled: false,
      status: "disabled",
    });
    expect((await controller.check()).checked).toBe(false);
    expect(fetchRelease).not.toHaveBeenCalled();
  });
});
