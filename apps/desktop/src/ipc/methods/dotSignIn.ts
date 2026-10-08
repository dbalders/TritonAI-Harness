// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The one-shot loopback listener serves the browser's sign-in return from a Node HTTP callback outside any Effect fiber.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  AWAIT_DOT_SIGN_IN_CHANNEL,
  CANCEL_DOT_SIGN_IN_CHANNEL,
  START_DOT_SIGN_IN_CHANNEL,
} from "../channels.ts";

const CALLBACK_PATH = "/dot/callback";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const identifier = /^[A-Za-z0-9_-]{43}$/;
const returnPage = (message: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>TritonAI Bot</title><body style="font:17px/1.6 system-ui;text-align:center;padding:12vh 24px">${message}</body></html>`;
const RETURN_PAGE = returnPage("Signed in. You can close this tab and return to TritonAI Harness.");
const SIGNUPS_CLOSED_PAGE = returnPage(
  "TritonAI Bot isn't accepting new users right now. You can close this tab.",
);

const DotSignInReturn = Schema.NullOr(
  Schema.Union([
    Schema.Struct({ requestId: Schema.String, code: Schema.String }),
    Schema.Struct({ requestId: Schema.String, error: Schema.Literal("signups_closed") }),
  ]),
);
export type DotSignInReturn = typeof DotSignInReturn.Type;

export interface DotSignInListener {
  readonly redirectUri: string;
  readonly result: Promise<DotSignInReturn>;
  readonly close: () => void;
}

/**
 * Listens once on loopback for the bot's sign-in return. The bot only redirects
 * its one-time code to 127.0.0.1, so a shared sign-in link cannot deliver that
 * code anywhere except this machine.
 */
export function listenForDotSignIn(timeoutMs = SIGN_IN_TIMEOUT_MS): Promise<DotSignInListener> {
  let settle!: (value: DotSignInReturn) => void;
  const result = new Promise<DotSignInReturn>((resolve) => (settle = resolve));
  const server = NodeHttp.createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const requestId = url.searchParams.get("requestId") ?? "";
    const code = url.searchParams.get("code") ?? "";
    // The bot refuses new accounts while signups are closed and says so here instead of a code.
    const refused = url.searchParams.get("error") === "signups_closed";
    if (
      request.method !== "GET" ||
      url.pathname !== CALLBACK_PATH ||
      !identifier.test(requestId) ||
      (!refused && !identifier.test(code))
    ) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        connection: "close",
      })
      .end(refused ? SIGNUPS_CLOSED_PAGE : RETURN_PAGE);
    close(refused ? { requestId, error: "signups_closed" } : { requestId, code });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = (value: DotSignInReturn = null) => {
    clearTimeout(timer);
    server.close();
    settle(value);
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      timer = setTimeout(() => close(null), timeoutMs);
      const { port } = server.address() as NodeNet.AddressInfo;
      resolve({ redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, result, close });
    });
  });
}

export const installDotSignIn = Effect.fn("desktop.ipc.installDotSignIn")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  let pending: DotSignInListener | undefined;
  let attempts = 0;
  const cancel = () => {
    pending?.close();
    pending = undefined;
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: START_DOT_SIGN_IN_CHANNEL,
      payload: Schema.Undefined,
      result: Schema.String,
      handler: () =>
        Effect.promise(async () => {
          const attempt = ++attempts;
          cancel();
          const listener = await listenForDotSignIn();
          // A newer start superseded this one while it was binding.
          if (attempt !== attempts) listener.close();
          else pending = listener;
          return listener.redirectUri;
        }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: AWAIT_DOT_SIGN_IN_CHANNEL,
      payload: Schema.String,
      result: DotSignInReturn,
      handler: Effect.fn("desktop.ipc.awaitDotSignIn")(function* (redirectUri) {
        const listener = pending;
        if (listener?.redirectUri !== redirectUri) return null;
        const returned = yield* Effect.promise(() => listener.result);
        if (returned) {
          const electronWindow = yield* ElectronWindow.ElectronWindow;
          const window = yield* electronWindow.currentMainOrFirst;
          if (Option.isSome(window)) yield* electronWindow.reveal(window.value);
        }
        return returned;
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: CANCEL_DOT_SIGN_IN_CHANNEL,
      payload: Schema.String,
      result: Schema.Void,
      handler: (redirectUri) =>
        Effect.sync(() => {
          if (pending?.redirectUri === redirectUri) cancel();
        }),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(cancel));
});
