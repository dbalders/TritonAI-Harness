import { afterEach, expect, it, vi } from "vite-plus/test";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else globalThis.window = originalWindow;
});

it.each([
  ["Alpha", "0.4.1", false],
  ["Latest", "0.4.1", false],
  ["Nightly", "0.4.1-nightly.20261026.1", true],
  ["Dev", "0.4.1", true],
  ["Beta", "0.4.1-nightly.20261026.1", true],
  ["Beta", "0.4.1", false],
])("makes the guided tour available for %s %s: %s", async (stageLabel, version, available) => {
  vi.stubEnv("APP_VERSION", version);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktopBridge: {
        getAppBranding: () => ({
          baseName: "TritonAI Harness",
          stageLabel,
          displayName: "TritonAI Harness",
        }),
      },
    },
  });
  expect((await import("./branding")).GUIDED_TOUR_AVAILABLE).toBe(available);
});
