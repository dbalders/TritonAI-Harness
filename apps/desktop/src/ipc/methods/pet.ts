import { DesktopPetStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopPet from "../../pet/DesktopPet.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

// The pet belongs to the renderer that opened it; -1 never matches one.
const ownerOf = (event: { readonly sender: { readonly id: number } } | undefined) =>
  event?.sender.id ?? -1;

export const openPet = makeIpcMethod({
  channel: IpcChannels.PET_OPEN_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.open")(function* (_, event) {
    const pet = yield* DesktopPet.DesktopPet;
    yield* pet.open(ownerOf(event));
  }),
});

export const closePet = makeIpcMethod({
  channel: IpcChannels.PET_CLOSE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.close")(function* () {
    const pet = yield* DesktopPet.DesktopPet;
    yield* pet.close();
  }),
});

export const setPetState = makeIpcMethod({
  channel: IpcChannels.PET_STATE_CHANNEL,
  payload: DesktopPetStateSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.pet.setState")(function* (state) {
    const pet = yield* DesktopPet.DesktopPet;
    yield* pet.setState(state);
  }),
});
