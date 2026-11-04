import type { DesktopPetState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { PET_ACTION_CHANNEL } from "../ipc/channels.ts";
import { makePetWindow } from "./PetWindow.ts";
import type { PetWindowAction } from "./petWindowAction.ts";

/** Owns the floating pet and forwards actions to the chat renderer. */
export class DesktopPet extends Context.Service<
  DesktopPet,
  {
    readonly open: (ownerId: number) => Effect.Effect<void>;
    readonly close: () => Effect.Effect<void>;
    readonly setState: (state: DesktopPetState) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/pet/DesktopPet") {}

function sendToOwner(ownerId: number, action: PetWindowAction) {
  const contents = Electron.webContents.fromId(ownerId);
  if (!contents || contents.isDestroyed()) return;
  contents.send(PET_ACTION_CHANNEL, action);
}

function petWindowBounds(): Electron.Rectangle {
  const displays = Electron.screen.getAllDisplays();
  const left = Math.min(...displays.map((display) => display.workArea.x));
  const top = Math.min(...displays.map((display) => display.workArea.y));
  const right = Math.max(...displays.map((display) => display.workArea.x + display.workArea.width));
  const bottom = Math.max(
    ...displays.map((display) => display.workArea.y + display.workArea.height),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function ownerWorkAreaForOwner(ownerId: number): Electron.Rectangle {
  const contents = Electron.webContents.fromId(ownerId);
  const owner = contents ? Electron.BrowserWindow.fromWebContents(contents) : null;
  if (!owner || owner.isDestroyed()) return Electron.screen.getPrimaryDisplay().workArea;
  return Electron.screen.getDisplayMatching(owner.getBounds()).workArea;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  let ownerId: number | null = null;
  const watchedOwners = new WeakSet();
  const petPreloadPath = environment.path.join(environment.dirname, "petPreload.cjs");
  const pet = makePetWindow(environment.platform, petPreloadPath, (action) => {
    if (ownerId === null) return;
    sendToOwner(ownerId, action);
    if (action.kind === "close" || (action.kind === "set-pet" && action.pet === "off")) {
      ownerId = null;
      pet.hide();
    }
  });

  const refreshWorkArea = () => {
    if (ownerId !== null) pet.show(petWindowBounds());
  };
  let screenListenersRegistered = false;
  const registerScreenListeners = () => {
    Electron.screen.on("display-metrics-changed", refreshWorkArea);
    Electron.screen.on("display-removed", refreshWorkArea);
    Electron.screen.on("display-added", refreshWorkArea);
    screenListenersRegistered = true;
  };
  // Foundation services are built before DesktopApp waits for Electron readiness.
  if (Electron.app.isReady()) registerScreenListeners();
  else Electron.app.once("ready", registerScreenListeners);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      ownerId = null;
      Electron.app.removeListener("ready", registerScreenListeners);
      if (screenListenersRegistered) {
        Electron.screen.removeListener("display-metrics-changed", refreshWorkArea);
        Electron.screen.removeListener("display-removed", refreshWorkArea);
        Electron.screen.removeListener("display-added", refreshWorkArea);
      }
      pet.destroy();
    }),
  );

  return DesktopPet.of({
    open: Effect.fn("DesktopPet.open")(function* (nextOwnerId) {
      if (ownerId !== nextOwnerId) {
        const contents = Electron.webContents.fromId(nextOwnerId);
        if (contents && !watchedOwners.has(contents)) {
          watchedOwners.add(contents);
          contents.once("destroyed", () => {
            if (ownerId !== nextOwnerId) return;
            ownerId = null;
            pet.hide();
          });
        }
      }
      ownerId = nextOwnerId;
      const bounds = petWindowBounds();
      const ownerArea = ownerWorkAreaForOwner(nextOwnerId);
      pet.show(bounds, {
        x: ownerArea.x + ownerArea.width - 84 - bounds.x,
        y: ownerArea.y + ownerArea.height - 84 - bounds.y,
      });
    }),
    close: Effect.fn("DesktopPet.close")(function* () {
      // Renderer teardown calls close on reload. Do not echo a user-style
      // close action into the same webContents; that would reset a persisted
      // pet selection after the page has already reloaded.
      ownerId = null;
      pet.hide();
    }),
    setState: Effect.fn("DesktopPet.setState")(function* (state) {
      if (state.pet === "off") {
        const currentOwnerId = ownerId;
        ownerId = null;
        pet.hide();
        if (currentOwnerId !== null) sendToOwner(currentOwnerId, { kind: "close" });
        return;
      }
      pet.update(state);
    }),
  });
});

export const layer = Layer.effect(DesktopPet, make);
