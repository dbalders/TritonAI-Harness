import { describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopLocalFilePath } from "./localFileAttachment";

const file = new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" });

describe("resolveDesktopLocalFilePath", () => {
  it("returns the original path for a native desktop-local backend", () => {
    expect(
      resolveDesktopLocalFilePath({
        bridge: {
          getLocalEnvironmentBootstraps: () => [
            {
              id: "primary",
              label: "Local",
              runningDistro: null,
              httpBaseUrl: "http://127.0.0.1:1234",
              wsBaseUrl: "ws://127.0.0.1:1234",
            },
          ],
          getPathForFile: () => "/Users/david/Downloads/data.csv",
        },
        backendId: "primary",
        file,
      }),
    ).toBe("/Users/david/Downloads/data.csv");
  });

  it("falls back to upload when the environment runs inside WSL", () => {
    const getPathForFile = vi.fn(() => "C:\\Users\\David\\Downloads\\data.csv");
    expect(
      resolveDesktopLocalFilePath({
        bridge: {
          getLocalEnvironmentBootstraps: () => [
            {
              id: "primary",
              label: "WSL (Ubuntu)",
              runningDistro: "Ubuntu",
              httpBaseUrl: "http://127.0.0.1:1234",
              wsBaseUrl: "ws://127.0.0.1:1234",
            },
          ],
          getPathForFile,
        },
        backendId: "primary",
        file,
      }),
    ).toBeNull();
    expect(getPathForFile).not.toHaveBeenCalled();
  });

  it("falls back to upload outside the desktop shell", () => {
    expect(resolveDesktopLocalFilePath({ bridge: null, backendId: null, file })).toBeNull();
  });

  it("falls back to upload when the selected backend is not host-native", () => {
    const getPathForFile = vi.fn(() => "/Users/david/Downloads/data.csv");
    expect(
      resolveDesktopLocalFilePath({
        bridge: {
          getLocalEnvironmentBootstraps: () => [
            {
              id: "primary",
              label: "Local",
              runningDistro: null,
              httpBaseUrl: "http://127.0.0.1:1234",
              wsBaseUrl: "ws://127.0.0.1:1234",
            },
          ],
          getPathForFile,
        },
        backendId: "remote",
        file,
      }),
    ).toBeNull();
    expect(getPathForFile).not.toHaveBeenCalled();
  });
});
