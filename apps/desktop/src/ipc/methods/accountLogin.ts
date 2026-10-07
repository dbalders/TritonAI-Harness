import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AccountLoginCallback } from "../../account/AccountLoginCallback.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class AccountLoginIpcError extends Data.TaggedError("AccountLoginIpcError")<{
  message: string;
}> {}

export const installAccountLoginHandlers = Effect.fn("desktop.ipc.installAccountLogin")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const windows = yield* ElectronWindow.ElectronWindow;
    const callbacks = new AccountLoginCallback();
    yield* Effect.addFinalizer(() => Effect.sync(() => callbacks.close()));
    const owner = Effect.fn("desktop.ipc.accountLogin.owner")(function* (
      event?: DesktopIpc.DesktopIpcInvokeEvent,
    ) {
      const main = yield* windows.main;
      if (!event || Option.isNone(main) || main.value.webContents.id !== event.sender.id)
        return yield* Effect.fail(
          new AccountLoginIpcError({
            message: "Account sign-in is only available in the Harness window.",
          }),
        );
      return main.value;
    });
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.ACCOUNT_LOGIN_PREPARE_CHANNEL,
        payload: Schema.Undefined,
        result: Schema.Struct({ id: Schema.String, returnUrl: Schema.String }),
        handler: Effect.fn("desktop.ipc.accountLogin.prepare")(function* (_input, event) {
          const window = yield* owner(event);
          return yield* Effect.tryPromise({
            try: () =>
              callbacks.prepare(window.webContents.id, () => {
                if (!window.isDestroyed()) {
                  if (window.isMinimized()) window.restore();
                  window.show();
                  window.focus();
                }
              }),
            catch: () =>
              new AccountLoginIpcError({ message: "Could not start desktop sign-in. Try again." }),
          });
        }),
      }),
    );
    const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.ACCOUNT_LOGIN_READ_CHANNEL,
        payload: id,
        result: Schema.NullOr(Schema.Struct({ requestId: id, completionCode: id })),
        handler: Effect.fn("desktop.ipc.accountLogin.read")(function* (id, event) {
          const window = yield* owner(event);
          return callbacks.read(window.webContents.id, id);
        }),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.ACCOUNT_LOGIN_CANCEL_CHANNEL,
        payload: id,
        result: Schema.Void,
        handler: Effect.fn("desktop.ipc.accountLogin.cancel")(function* (id, event) {
          const window = yield* owner(event);
          callbacks.cancel(window.webContents.id, id);
        }),
      }),
    );
  },
);
