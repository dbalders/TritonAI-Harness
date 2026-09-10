export function trackThreadReadState(input: {
  threadKey: string;
  createdAt: string;
  startedAt: string | null | undefined;
  completedAt: string | null | undefined;
  markVisited: (threadKey: string, visitedAt: string) => void;
}): () => void {
  // A new thread needs a baseline before its first response. Use server
  // timestamps so clock skew cannot swallow a later completion or wake.
  const visitedAt = input.completedAt ?? input.startedAt ?? input.createdAt;
  const markVisibleStateVisited = () => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    input.markVisited(input.threadKey, visitedAt);
  };

  markVisibleStateVisited();
  document.addEventListener("visibilitychange", markVisibleStateVisited);
  window.addEventListener("focus", markVisibleStateVisited);
  return () => {
    document.removeEventListener("visibilitychange", markVisibleStateVisited);
    window.removeEventListener("focus", markVisibleStateVisited);
  };
}
