import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.die("unexpected metadata read"),
  name: Effect.succeed("T3 Code"),
  systemLocale: Effect.succeed("en-US"),
  whenReady: Effect.void,
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  isDefaultProtocolClient: () => Effect.succeed(false),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

const electronDialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.succeed(Option.none()),
  pickFiles: () => Effect.succeed([]),
  confirm: () => Effect.succeed(false),
  showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  showErrorBox: () => Effect.void,
} satisfies ElectronDialog.ElectronDialog["Service"]);

const desktopUpdatesLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
  getState: Effect.die("unexpected getState"),
  isActionActive: Effect.succeed(false),
  isInstallActive: Effect.succeed(false),
  subscribe: Effect.die("unexpected subscribe"),
  emitState: Effect.void,
  disabledReason: Effect.succeed(Option.none()),
  configure: Effect.void,
  setChannel: () => Effect.die("unexpected setChannel"),
  check: () => Effect.die("unexpected check"),
  download: Effect.die("unexpected download"),
  install: Effect.die("unexpected install"),
  installPrepared: () => Effect.die("unexpected installPrepared"),
} satisfies DesktopUpdates.DesktopUpdates["Service"]);

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.succeed({} as Electron.BrowserWindow),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: (direction) =>
      Deferred.succeed(selectedAction, `zoom-${direction}`).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
  } satisfies ElectronMenu.ElectronMenu["Service"]);

const configureMenu = (
  selectedAction: Deferred.Deferred<string>,
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Effect.gen(function* () {
    const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
    yield* menu.configure;
  }).pipe(
    Effect.provide(
      DesktopApplicationMenu.layer.pipe(
        Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
        Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
        Layer.provideMerge(desktopUpdatesLayer),
        Layer.provideMerge(electronDialogLayer),
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(
          DesktopEnvironment.layer(environmentInput).pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
          ),
        ),
      ),
    ),
  );

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "Settings...");
      assert.isDefined(settingsItem);
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );

  it.effect("owns Paste as Text and routes it through the renderer", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const editMenu = template.find((item) => item.label === "Edit");
      assert.isDefined(editMenu);
      if (!Array.isArray(editMenu.submenu)) {
        throw new Error("Expected Edit menu submenu to be an array.");
      }
      const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "Paste as Text");
      assert.isDefined(pasteAsTextItem);
      assert.equal(pasteAsTextItem.accelerator, "CmdOrCtrl+Shift+V");
      if (typeof pasteAsTextItem.click !== "function") {
        throw new Error("Expected Paste as Text menu item to have a click handler.");
      }

      pasteAsTextItem.click(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {} as KeyboardEvent,
      );
      assert.equal(yield* Deferred.await(selectedAction), "paste-as-text");
    }),
  );

  // Chromium pastes as plain text for the accelerator on its own. Dispatching
  // the action as well injects a second paste, which doubles the pasted text.
  it.effect("leaves the accelerator to Chromium instead of injecting a paste", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const editMenu = template.find((item) => item.label === "Edit");
      if (!Array.isArray(editMenu?.submenu)) {
        throw new Error("Expected Edit menu submenu to be an array.");
      }
      const pasteAsTextItem = editMenu.submenu.find((item) => item.label === "Paste as Text");
      if (typeof pasteAsTextItem?.click !== "function") {
        throw new Error("Expected Paste as Text menu item to have a click handler.");
      }

      pasteAsTextItem.click(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        {
          triggeredByAccelerator: true,
        } as unknown as KeyboardEvent,
      );
      assert.isFalse(yield* Deferred.isDone(selectedAction));
    }),
  );

  // Zoom must route through DesktopWindow.zoomMain instead of the Electron
  // zoom roles: the roles zoom whichever webContents has focus, which breaks
  // app zoom while an embedded preview WebContentsView holds focus.
  it.effect("routes View menu zoom to the main window instead of zoom roles", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* configureMenu(selectedAction, applicationMenuTemplate);

      const template = yield* Deferred.await(applicationMenuTemplate);
      const viewMenu = template.find((item) => item.label === "View");
      assert.isDefined(viewMenu);
      if (!Array.isArray(viewMenu.submenu)) {
        throw new Error("Expected View menu submenu to be an array.");
      }

      assert.isUndefined(
        viewMenu.submenu.find((item) => item.role?.toLowerCase().includes("zoom")),
      );

      const zoomIn = viewMenu.submenu.find((item) => item.label === "Zoom In");
      assert.isDefined(zoomIn);
      assert.equal(zoomIn.accelerator, "CmdOrCtrl+=");
      if (typeof zoomIn.click !== "function") {
        throw new Error("Expected Zoom In menu item to have a click handler.");
      }

      zoomIn.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "zoom-in");
    }),
  );

  it.effect("checks the Harness version from the native menu", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const shownMessage = yield* Deferred.make<Electron.MessageBoxOptions>();
      const checkResult = {
        checked: true,
        state: {
          enabled: true,
          omittedReleaseCount: 0,
          status: "up-to-date",
          channel: "latest",
          currentVersion: "1.2.3",
          hostArch: "arm64",
          appArch: "arm64",
          runningUnderArm64Translation: false,
          availableVersion: null,
          downloadedVersion: null,
          releaseNotes: [],
          downloadPercent: null,
          checkedAt: "2026-07-10T12:00:00.000Z",
          message: null,
          errorContext: null,
          canRetry: false,
        },
      } as const;
      const updateLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
        getState: Effect.succeed(checkResult.state),
        isActionActive: Effect.succeed(false),
        isInstallActive: Effect.succeed(false),
        subscribe: Effect.die("unexpected subscribe"),
        installPrepared: () => Effect.die("unexpected installPrepared"),
        emitState: Effect.void,
        disabledReason: Effect.succeed(Option.none()),
        configure: Effect.void,
        setChannel: () => Effect.die("unexpected setChannel"),
        check: () => Effect.succeed(checkResult),
        download: Effect.die("unexpected download"),
        install: Effect.die("unexpected install"),
      } satisfies DesktopUpdates.DesktopUpdates["Service"]);
      const dialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
        pickFolder: () => Effect.succeed(Option.none()),
        pickFiles: () => Effect.succeed([]),
        confirm: () => Effect.succeed(false),
        showMessageBox: (options) =>
          Deferred.succeed(shownMessage, options).pipe(
            Effect.as({ response: 0, checkboxChecked: false }),
          ),
        showErrorBox: () => Effect.void,
      } satisfies ElectronDialog.ElectronDialog["Service"]);

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
            Layer.provideMerge(updateLayer),
            Layer.provideMerge(dialogLayer),
            Layer.provideMerge(electronAppLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer(environmentInput).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      const helpMenu = template.find((item) => item.role === "help");
      assert.isDefined(helpMenu);
      if (!Array.isArray(helpMenu.submenu)) {
        throw new Error("Expected Help menu submenu to be an array.");
      }
      const updateItem = helpMenu.submenu.find((item) => item.label === "Check for Updates...");
      assert.isDefined(updateItem);
      const updateClick = updateItem.click;
      if (typeof updateClick !== "function") {
        throw new Error("Expected update menu item to have a click handler.");
      }

      updateClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      const message = yield* Deferred.await(shownMessage);
      assert.equal(message.title, "You're up to date!");
      assert.equal(
        message.message,
        "TritonAI Harness 1.2.3 is currently the newest version available.",
      );
    }),
  );

  it.effect("explains when Harness updates are disabled without checking", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const shownMessage = yield* Deferred.make<Electron.MessageBoxOptions>();
      let checkCalls = 0;
      const updateLayer = Layer.succeed(DesktopUpdates.DesktopUpdates, {
        getState: Effect.die("unexpected getState"),
        isActionActive: Effect.succeed(false),
        isInstallActive: Effect.succeed(false),
        subscribe: Effect.die("unexpected subscribe"),
        installPrepared: () => Effect.die("unexpected installPrepared"),
        emitState: Effect.void,
        disabledReason: Effect.succeed(Option.some("This build is not signed for updates.")),
        configure: Effect.void,
        setChannel: () => Effect.die("unexpected setChannel"),
        check: () =>
          Effect.sync(() => {
            checkCalls += 1;
            throw new Error("unexpected check");
          }),
        download: Effect.die("unexpected download"),
        install: Effect.die("unexpected install"),
      } satisfies DesktopUpdates.DesktopUpdates["Service"]);
      const dialogLayer = Layer.succeed(ElectronDialog.ElectronDialog, {
        pickFolder: () => Effect.succeed(Option.none()),
        pickFiles: () => Effect.succeed([]),
        confirm: () => Effect.succeed(false),
        showMessageBox: (options) =>
          Deferred.succeed(shownMessage, options).pipe(
            Effect.as({ response: 0, checkboxChecked: false }),
          ),
        showErrorBox: () => Effect.void,
      } satisfies ElectronDialog.ElectronDialog["Service"]);

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
            Layer.provideMerge(updateLayer),
            Layer.provideMerge(dialogLayer),
            Layer.provideMerge(electronAppLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer(environmentInput).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      const helpMenu = template.find((item) => item.role === "help");
      assert.isDefined(helpMenu);
      if (!Array.isArray(helpMenu.submenu)) {
        throw new Error("Expected Help menu submenu to be an array.");
      }
      const updateItem = helpMenu.submenu.find((item) => item.label === "Check for Updates...");
      assert.isDefined(updateItem);
      if (typeof updateItem.click !== "function") {
        throw new Error("Expected update menu item to have a click handler.");
      }

      updateItem.click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      const message = yield* Deferred.await(shownMessage);
      assert.equal(message.title, "Updates unavailable");
      assert.equal(checkCalls, 0);
    }),
  );
});
