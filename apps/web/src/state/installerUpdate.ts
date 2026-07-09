import { useAtomValue } from "@effect/atom-react";
import type { DesktopBridge, InstallerUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { Atom } from "effect/unstable/reactivity";

type InstallerUpdateBridge = Pick<
  DesktopBridge,
  "getInstallerUpdateState" | "onInstallerUpdateState"
>;

function getInstallerUpdateBridge(): InstallerUpdateBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

export function createInstallerUpdateStateAtom(getBridge: () => InstallerUpdateBridge | undefined) {
  const updates = Stream.callback<InstallerUpdateState | null>((queue) =>
    Effect.gen(function* () {
      const bridge = getBridge();
      if (!bridge) {
        Queue.offerUnsafe(queue, null);
        return yield* Effect.never;
      }

      let receivedUpdate = false;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          bridge.onInstallerUpdateState((state) => {
            receivedUpdate = true;
            Queue.offerUnsafe(queue, state);
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );

      const initialState = yield* Effect.tryPromise(() => bridge.getInstallerUpdateState()).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (!receivedUpdate && initialState !== null) {
        Queue.offerUnsafe(queue, initialState);
      }

      return yield* Effect.never;
    }),
  );

  return Atom.make(updates, { initialValue: null }).pipe(
    Atom.keepAlive,
    Atom.withLabel("desktop:installer-update-state"),
  );
}

const installerUpdateStateAtom = createInstallerUpdateStateAtom(getInstallerUpdateBridge);

export function useInstallerUpdateState(): InstallerUpdateState | null {
  return AsyncResult.getOrElse(useAtomValue(installerUpdateStateAtom), () => null);
}
