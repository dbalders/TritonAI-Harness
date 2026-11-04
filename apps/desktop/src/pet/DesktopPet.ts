import type { DesktopPetState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { PET_ACTION_CHANNEL } from "../ipc/channels.ts";
import { makePetWindow, type PetWindowArea } from "./PetWindow.ts";
import type { PetWindowAction } from "./petWindowAction.ts";

/** Owns the floating pet and forwards actions to the chat renderer. */
export class DesktopPet extends Context.Service<
  DesktopPet,
  {
    readonly open: (ownerId: number) => Effect.Effect<void>;
    readonly close: (ownerId?: number) => Effect.Effect<void>;
    readonly setState: (ownerId: number, state: DesktopPetState) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/pet/DesktopPet") {}

function sendToOwners(ownerIds: ReadonlySet<number>, action: PetWindowAction) {
  for (const ownerId of ownerIds) sendToOwner(ownerId, action);
}

function sendToOwner(ownerId: number, action: PetWindowAction) {
  const contents = Electron.webContents.fromId(ownerId);
  if (!contents || contents.isDestroyed()) return;
  contents.send(PET_ACTION_CHANNEL, action);
}

function petWindowAreas(): PetWindowArea[] {
  return Electron.screen.getAllDisplays().map((display) => ({
    id: display.id,
    area: display.workArea,
  }));
}

function ownerWorkAreaForOwner(ownerId: number): Electron.Rectangle {
  const contents = Electron.webContents.fromId(ownerId);
  const owner = contents ? Electron.BrowserWindow.fromWebContents(contents) : null;
  if (!owner || owner.isDestroyed()) return Electron.screen.getPrimaryDisplay().workArea;
  return Electron.screen.getDisplayMatching(owner.getBounds()).workArea;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const ownerIds = new Set<number>();
  let currentOwnerId: number | null = null;
  const ownerStates = new Map<number, DesktopPetState>();
  const watchedOwners = new WeakSet();
  const petPreloadPath = environment.path.join(environment.dirname, "petPreload.cjs");
  const pet = makePetWindow(environment.platform, petPreloadPath, (action) => {
    if (ownerIds.size === 0) return;
    // Thread navigation is window-local: sending it to every renderer would
    // change the active conversation in unrelated Harness windows.
    if (action.kind === "select-thread") {
      if (currentOwnerId !== null) sendToOwner(currentOwnerId, action);
      return;
    }
    sendToOwners(ownerIds, action);
    if (action.kind === "close" || (action.kind === "set-pet" && action.pet === "off")) {
      ownerIds.clear();
      ownerStates.clear();
      currentOwnerId = null;
      pet.hide();
    }
  });

  const applyCurrentOwnerState = () => {
    if (currentOwnerId === null) return;
    const ownerState = ownerStates.get(currentOwnerId);
    if (ownerState) pet.update(ownerState);
  };

  const refreshWorkArea = () => {
    if (currentOwnerId !== null) pet.show(petWindowAreas());
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
      ownerIds.clear();
      ownerStates.clear();
      currentOwnerId = null;
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
      yield* Effect.sync(() => {
        ownerIds.add(nextOwnerId);
        currentOwnerId = nextOwnerId;
        const contents = Electron.webContents.fromId(nextOwnerId);
        if (contents && !watchedOwners.has(contents)) {
          watchedOwners.add(contents);
          contents.once("destroyed", () => {
            ownerIds.delete(nextOwnerId);
            ownerStates.delete(nextOwnerId);
            if (currentOwnerId !== nextOwnerId) return;
            currentOwnerId = ownerIds.size > 0 ? ([...ownerIds][0] ?? null) : null;
            if (currentOwnerId === null) pet.hide();
            else applyCurrentOwnerState();
          });
        }
        const areas = petWindowAreas();
        const ownerArea = ownerWorkAreaForOwner(nextOwnerId);
        pet.show(areas, {
          x: ownerArea.x + ownerArea.width - 84,
          y: ownerArea.y + ownerArea.height - 84,
        });
        applyCurrentOwnerState();
      });
    }),
    close: Effect.fn("DesktopPet.close")(function* (requesterId) {
      yield* Effect.sync(() => {
        // Renderer teardown is sender-aware. Closing one window must not hide
        // the pet while another renderer still wants it visible.
        const ownerId = requesterId ?? currentOwnerId;
        if (ownerId === null || !ownerIds.has(ownerId)) return;
        ownerIds.delete(ownerId);
        ownerStates.delete(ownerId);
        if (currentOwnerId !== ownerId) return;
        currentOwnerId = ownerIds.size > 0 ? ([...ownerIds][0] ?? null) : null;
        if (currentOwnerId === null) pet.hide();
        else applyCurrentOwnerState();
      });
    }),
    setState: Effect.fn("DesktopPet.setState")(function* (ownerId, state) {
      yield* Effect.sync(() => {
        if (state.pet === "off") {
          const previousOwners = new Set(ownerIds);
          ownerIds.clear();
          ownerStates.clear();
          currentOwnerId = null;
          pet.hide();
          sendToOwners(previousOwners, { kind: "close" });
          return;
        }
        if (!ownerIds.has(ownerId)) return;
        ownerStates.set(ownerId, state);
        if (currentOwnerId === ownerId) pet.update(state);
      });
    }),
  });
});

export const layer = Layer.effect(DesktopPet, make);
