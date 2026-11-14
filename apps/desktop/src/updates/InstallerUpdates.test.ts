import { describe, expect, it } from "vite-plus/test";

import {
  compareInstallerVersions,
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
});
