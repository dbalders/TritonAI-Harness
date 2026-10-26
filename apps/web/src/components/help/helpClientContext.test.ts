import { DEFAULT_CLIENT_SETTINGS, secretSetting, type ClientSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SETTINGS_SEARCH_ITEMS } from "../settings/settingsSearch";
import { captureHelpClientContext, helpSettingsSnapshot } from "./helpClientContext";

const reads = vi.hoisted(() => ({
  hydrate: vi.fn<() => Promise<void>>(),
  settings: vi.fn<() => ClientSettings>(),
}));
vi.mock("../../hooks/useSettings", () => ({
  ensureClientSettingsHydrated: reads.hydrate,
  getClientSettings: reads.settings,
}));

beforeEach(() => {
  reads.hydrate.mockReset().mockResolvedValue(undefined);
  reads.settings.mockReset().mockReturnValue(DEFAULT_CLIENT_SETTINGS);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains declared preferences while omitting custom strings, paths, profiles and secrets", () => {
  const schema = Schema.Struct({
    enabled: Schema.Boolean,
    count: Schema.Number,
    appearance: Schema.Literals(["light", "dark"]),
    viewport: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
    renamedCredential: secretSetting(Schema.String),
    customText: Schema.String,
    endpointUrl: Schema.String,
    binaryPath: Schema.String,
    browserProfiles: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    nested: Schema.Struct({ innocentName: secretSetting(Schema.Boolean) }),
  });
  const source = Object.freeze({
    enabled: false,
    count: 2,
    appearance: "dark",
    viewport: Object.freeze({ width: 800, height: 600 }),
    renamedCredential: "never-send-this",
    customText: "arbitrary instruction payload",
    endpointUrl: "https://service.invalid/?token=private-token",
    binaryPath: "/custom-mount/private app/tool",
    browserProfiles: [{ id: "profile-private", name: "Private browser" }],
    nested: { innocentName: true },
    unknownPrivateField: "never-send-extra",
  });
  const result = helpSettingsSnapshot(source, schema);
  expect(result.entries).toEqual(
    expect.arrayContaining([
      { key: "enabled", value: "false" },
      { key: "count", value: "2" },
      { key: "appearance", value: "dark" },
      { key: "viewport", value: '{"width":800,"height":600}' },
      { key: "renamedCredential", value: "Configured (value omitted)", configured: true },
    ]),
  );
  expect(result.totalCount).toBe(11);
  expect(result.omittedCount).toBe(7);
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    "never-send",
    "arbitrary instruction",
    "private-token",
    "/custom-mount",
    "profile-private",
    "Private browser",
    "unknownPrivateField",
  ])
    expect(serialized).not.toContain(privateValue);
  expect(source.enabled).toBe(false);
});

it("reads schema-declared presentation text while withholding arbitrary path-shaped values", () => {
  const snapshot = helpSettingsSnapshot({
    ...DEFAULT_CLIENT_SETTINGS,
    fontFamilySans: "Berkeley Mono",
  });
  expect(snapshot.entries).toContainEqual({ key: "fontFamilySans", value: "Berkeley Mono" });
  const unsafe = helpSettingsSnapshot({
    ...DEFAULT_CLIENT_SETTINGS,
    fontFamilySans: "/custom/private-font",
  });
  expect(JSON.stringify(unsafe)).not.toContain("/custom/private-font");
});

it("omits non-JSON literals and arbitrary collections without traversing their private payloads", () => {
  const readPrivatePayload = vi.fn(() => {
    throw new Error("Do not read arbitrary entries");
  });
  const values: string[] = [];
  Object.defineProperty(values, 0, { get: readPrivatePayload, enumerable: true });
  const result = helpSettingsSnapshot(
    { values, largeInteger: 3n, invalidChoice: "unexpected custom payload" },
    Schema.Struct({
      values: Schema.Array(Schema.String),
      largeInteger: Schema.Literal(3n),
      invalidChoice: Schema.Literals(["light", "dark"]),
    }),
  );
  expect(result.omittedCount).toBe(3);
  expect(readPrivatePayload).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("unexpected custom payload");
});

it("waits for hydration, captures current preferences and ships the actual catalog metadata", async () => {
  let hydrate!: () => void;
  reads.hydrate.mockReturnValue(
    new Promise<void>((resolve) => {
      hydrate = resolve;
    }),
  );
  const pending = captureHelpClientContext(() => true);
  expect(reads.settings).not.toHaveBeenCalled();
  const current = Object.freeze({ ...DEFAULT_CLIENT_SETTINGS, composerRichTextEnabled: false });
  reads.settings.mockReturnValue(current);
  hydrate();
  const result = await pending;
  expect(result?.surface).toBe("web");
  expect(result?.settingsStatus).toBe("ready");
  expect(result?.settings.entries).toContainEqual({
    key: "composerRichTextEnabled",
    value: "false",
  });
  const item = SETTINGS_SEARCH_ITEMS.find((entry) => entry.id === "review-guide-model")!;
  expect(result?.settingsCatalog).toContainEqual({
    id: item.id,
    title: item.title,
    route: `${item.to}#${item.targetId}`,
    searchTerms: item.searchTerms.join(" "),
    scope: item.scope,
  });
  for (const route of ["/settings/plugins", "/settings/skills", "/settings/scheduled-tasks"]) {
    expect(result?.settingsCatalog).toEqual(
      expect.arrayContaining([expect.objectContaining({ route })]),
    );
  }
  expect(result?.computerUse).toBeUndefined();
  expect(current.composerRichTextEnabled).toBe(false);
});

it("reads desktop readiness without requesting permissions, mutating settings or using host state", async () => {
  const readiness = {
    enabled: true,
    available: true,
    running: false,
    accessibilityPermission: false,
    screenRecordingPermission: null,
  };
  const getComputerUseState = vi.fn(async () => ({
    ...readiness,
    privateExtra: "/desktop/private",
  }));
  const mutate = vi.fn();
  vi.stubGlobal("window", {
    desktopBridge: {
      getClientPlatform: () => "win32",
      getComputerUseState,
      setComputerUseEnabled: mutate,
      requestSystemPermission: mutate,
      getTritonAiCredentialStatus: mutate,
    },
  });
  const result = await captureHelpClientContext(() => true);
  expect(result).toMatchObject({ surface: "desktop", platform: "win32", computerUse: readiness });
  expect(result?.computerUse).toEqual(readiness);
  expect(mutate).not.toHaveBeenCalled();
  expect(getComputerUseState).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("/desktop/private");
});

it.each(["hydration", "desktop"])(
  "abandons late %s reads when the request is no longer current",
  async (stage) => {
    let finish!: (value?: unknown) => void;
    const pendingRead = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    const getComputerUseState = vi.fn(() => pendingRead);
    vi.stubGlobal("window", { desktopBridge: { getComputerUseState } });
    if (stage === "hydration") reads.hydrate.mockReturnValue(pendingRead);
    let current = true;
    const pending = captureHelpClientContext(() => current);
    await Promise.resolve();
    await Promise.resolve();
    current = false;
    finish();
    expect(await pending).toBeNull();
    expect(reads.settings).not.toHaveBeenCalled();
    expect(getComputerUseState).toHaveBeenCalledTimes(stage === "desktop" ? 1 : 0);
  },
);
