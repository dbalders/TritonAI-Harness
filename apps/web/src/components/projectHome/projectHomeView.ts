import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadStatusPill } from "../Sidebar.logic";

export function projectHomeThreads(threads: ReadonlyArray<EnvironmentThreadShell>) {
  const recent = threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        thread.lineage.relationshipToParent !== "subagent",
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const needsYou = recent.filter((thread) => {
    const label = resolveThreadStatusPill({ thread })?.label;
    return (
      label === "Pending Approval" ||
      label === "Awaiting Input" ||
      label === "Plan Ready" ||
      thread.runtime?.status === "failed" ||
      thread.latestRun?.status === "failed"
    );
  });
  const working = recent.filter((thread) => {
    const label = resolveThreadStatusPill({ thread })?.label;
    return label === "Working" || label === "Connecting" || label === "Waiting";
  });
  const finished = recent.filter(
    (thread) =>
      !needsYou.includes(thread) &&
      !working.includes(thread) &&
      thread.latestRun?.status === "completed",
  );
  return { recent, needsYou, working, finished };
}

export function projectMemorySections(markdown: string) {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "");
  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^##\s+(.+)$/u.exec(line);
    if (heading) sections.push({ heading: heading[1]!, lines: [] });
    else if (sections.length && line.trim()) {
      const text = line
        .trim()
        .replace(/^[-*]\s+/u, "")
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
        .replace(/\[\[([^\]]+)\]\]/gu, "$1");
      sections.at(-1)!.lines.push(text);
    }
  }
  return sections
    .map((section) => ({
      ...section,
      lines:
        section.heading.toLowerCase() === "recent"
          ? section.lines.slice(-5).toReversed()
          : section.lines.slice(0, 8),
    }))
    .filter((section) => section.lines.length > 0);
}

export function projectThreadExcerpt(
  thread: EnvironmentThreadShell,
  report?: string,
): string | null {
  const text = report ?? thread.source.latestVisibleMessage?.text;
  if (!text?.trim()) return null;
  const clean = text
    .trim()
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\s+/gu, " ");
  if (clean.length <= 240) return clean;
  const cut = clean.lastIndexOf(" ", 240);
  return `${clean.slice(0, cut > 160 ? cut : 240)}…`;
}
