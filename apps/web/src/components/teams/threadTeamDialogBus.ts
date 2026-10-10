import type { ThreadId } from "@t3tools/contracts";

// The chat view owns its thread's team dialogs; other entry points such as the command palette
// ask it to open one without owning that state.
const OPEN_THREAD_TEAM_DIALOG_EVENT = "t3code:open-thread-team-dialog";

export type ThreadTeamDialogRequest =
  | { readonly kind: "share"; readonly threadId: ThreadId; readonly text: string }
  | { readonly kind: "memory" | "skill"; readonly threadId: ThreadId };

export function openThreadTeamDialog(request: ThreadTeamDialogRequest): void {
  window.dispatchEvent(new CustomEvent(OPEN_THREAD_TEAM_DIALOG_EVENT, { detail: request }));
}

export function onOpenThreadTeamDialog(
  listener: (request: ThreadTeamDialogRequest) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<ThreadTeamDialogRequest>).detail);
  };
  window.addEventListener(OPEN_THREAD_TEAM_DIALOG_EVENT, handler);
  return () => window.removeEventListener(OPEN_THREAD_TEAM_DIALOG_EVENT, handler);
}
