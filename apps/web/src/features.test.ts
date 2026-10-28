import { afterEach, expect, it, vi } from "vite-plus/test";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else globalThis.window = originalWindow;
});

it.each([
  ["0.4.1", false, "", false],
  ["0.4.1-nightly.20261027.1", false, "", true],
  ["0.4.1-preview.20261027.1", false, "", true],
  ["0.4.1", true, "", true],
  ["0.4.1", false, "nightly", true],
  ["0.4.1-nightly.20261027.1", false, "latest", false],
  ["0.4.1", false, "unrecognized", false],
])("gates %s (dev=%s, hosted=%s): %s", async (version, development, hosted, available) => {
  vi.stubEnv("APP_VERSION", version);
  vi.stubEnv("DEV", development);
  vi.stubEnv("VITE_HOSTED_APP_CHANNEL", hosted);
  expect((await import("./features")).isFeatureAvailable("guidedTour")).toBe(available);
});

it("does not enable experiments from a display label or a selected update channel", async () => {
  vi.stubEnv("APP_VERSION", "0.4.1");
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktopBridge: {
        getAppBranding: () => ({
          baseName: "TritonAI Harness",
          stageLabel: "Nightly",
          displayName: "TritonAI Harness Nightly",
        }),
        getUpdateState: () => ({ channel: "nightly" }),
      },
    },
  });
  expect((await import("./features")).isFeatureAvailable("guidedTour")).toBe(false);
});

it.each([
  ["0.4.1", "nightly", false],
  ["0.4.1-nightly.20261027.1", "latest", true],
])(
  "uses the desktop version %s instead of the hosted channel %s",
  async (version, hosted, available) => {
    vi.stubEnv("APP_VERSION", version);
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", hosted);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge: {} },
    });
    expect((await import("./features")).isFeatureAvailable("guidedTour")).toBe(available);
  },
);
