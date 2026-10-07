import { createContext, use, useCallback } from "react";
import type { ChatComposerHandle } from "./components/chat/ChatComposer";

export type ComposerHandleRef = React.RefObject<ChatComposerHandle | null>;

export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null);

export function useComposerHandleContext(): ComposerHandleRef | null {
  return use(ComposerHandleContext);
}

/**
 * Focuses the composer once a new-thread request opens a thread. Reopening the
 * empty draft already on screen neither navigates nor changes the active
 * thread, so ChatView's focus-on-thread-change never fires and focus would stay
 * on the button or field that made the request.
 */
export function useFocusComposerAfterNewThread(): (request: Promise<unknown>) => void {
  const composerHandleRef = useComposerHandleContext();
  return useCallback(
    (request) => {
      void request
        .then((opened) => {
          if (!opened) return;
          window.requestAnimationFrame(() => composerHandleRef?.current?.focusAtEnd());
        })
        .catch((error: unknown) => {
          console.error("Could not open a new thread.", error);
        });
    },
    [composerHandleRef],
  );
}
