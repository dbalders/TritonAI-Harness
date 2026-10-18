import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadStatusPill } from "../Sidebar.logic";

export type ProjectThreadStatus = {
  label: string;
  kind: "needs-you" | "working" | "quiet";
  /** Matches the sidebar's status colors. */
  textClass: string;
  dotClass: string;
};

const NEEDS_YOU_LABELS: Record<string, string> = {
  "Pending Approval": "Needs your approval",
  "Awaiting Input": "Has a question for you",
  "Plan Ready": "Plan ready for review",
};

const WORKING_LABELS: Record<string, string> = {
  Working: "Working",
  Connecting: "Starting",
  Waiting: "Waiting on background work",
};

const QUIET = { textClass: "text-muted-foreground", dotClass: "bg-muted-foreground/40" };

/**
 * What a thread's latest state means for the person catching up. "Agent
 * finished" only says the latest run completed, not that anyone reviewed it.
 */
export function projectThreadStatus(thread: EnvironmentThreadShell): ProjectThreadStatus | null {
  const pill = resolveThreadStatusPill({ thread });
  const colors = pill
    ? {
        textClass: pill.label === "Waiting" ? QUIET.textClass : pill.colorClass,
        dotClass: `${pill.dotClass}${pill.pulse ? " motion-safe:animate-pulse" : ""}`,
      }
    : QUIET;
  const needsYou = pill && NEEDS_YOU_LABELS[pill.label];
  if (needsYou) return { label: needsYou, kind: "needs-you", ...colors };
  const working = pill && WORKING_LABELS[pill.label];
  if (working) return { label: working, kind: "working", ...colors };
  if (thread.runtime?.status === "failed" || thread.latestRun?.status === "failed") {
    return {
      label: "Run failed",
      kind: "needs-you",
      textClass: "text-destructive",
      dotClass: "bg-destructive",
    };
  }
  const run = thread.latestRun?.status;
  if (run === "completed") return { label: "Agent finished", kind: "quiet", ...QUIET };
  if (run === "interrupted" || run === "cancelled") {
    return { label: "Stopped", kind: "quiet", ...QUIET };
  }
  return null;
}

export function projectHomeThreads(threads: ReadonlyArray<EnvironmentThreadShell>) {
  const recent = threads
    .filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        thread.lineage.relationshipToParent !== "subagent",
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const needsYou: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const updates: EnvironmentThreadShell[] = [];
  for (const thread of recent) {
    const kind = projectThreadStatus(thread)?.kind;
    if (kind === "needs-you") needsYou.push(thread);
    else if (kind === "working") working.push(thread);
    else updates.push(thread);
  }
  return { recent, needsYou, working, updates };
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One sentence for the top of the page. It only states what thread state
 * shows; it never claims the project itself is done.
 */
export function projectHomeHeadline(
  view: ReturnType<typeof projectHomeThreads>,
  connected: boolean,
): string {
  if (!view.recent.length) return "No threads yet";
  if (view.needsYou.length) {
    return `${plural(view.needsYou.length, "thread needs", "threads need")} you`;
  }
  if (view.working.length)
    return `${plural(view.working.length, "agent is", "agents are")} working`;
  return connected ? "No pending agent requests" : "No saved agent requests pending";
}

function projectHomeDayLabel(iso: string, nowMs: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const now = new Date(nowMs);
  const day = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Groups threads, already newest first, under the day they last changed. */
export function projectHomeDays(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  nowMs: number = Date.now(),
) {
  const days: { label: string; threads: EnvironmentThreadShell[] }[] = [];
  for (const thread of threads) {
    const label = projectHomeDayLabel(thread.updatedAt, nowMs);
    if (days.at(-1)?.label === label) days.at(-1)!.threads.push(thread);
    else days.push({ label, threads: [thread] });
  }
  return days;
}

function plainMemoryText(line: string) {
  return line
    .trim()
    .replace(/^[-*]\s+/u, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
    .replace(/\[\[([^\]]+)\]\]/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1");
}

/**
 * Reads the generated project note. Its Recent lines link the daily note,
 * `- [[2026-10-17 Device]]: summary`, so they become a dated history without
 * the device name. Any other section the user added keeps its heading.
 */
export function projectMemoryNote(markdown: string) {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "");
  const history: { day: string | null; text: string }[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  let current: "recent" | { heading: string; lines: string[] } | null = null;
  for (const line of body.split(/\r?\n/u)) {
    const heading = /^##\s+(.+)$/u.exec(line);
    if (heading) {
      const title = heading[1]!.trim();
      current = title.toLowerCase() === "recent" ? "recent" : { heading: title, lines: [] };
      if (current !== "recent") sections.push(current);
      continue;
    }
    if (!current || !line.trim()) continue;
    if (current === "recent") {
      const dated = /^[-*]\s+\[\[(\d{4}-\d{2}-\d{2})[^\]]*\]\]:\s*(.+)$/u.exec(line.trim());
      history.push(
        dated
          ? { day: dated[1]!, text: plainMemoryText(dated[2]!) }
          : { day: null, text: plainMemoryText(line) },
      );
    } else {
      current.lines.push(plainMemoryText(line));
    }
  }
  return {
    history: history.toReversed(),
    sections: sections
      .map((section) => ({ ...section, lines: section.lines.slice(0, 8) }))
      .filter((section) => section.lines.length > 0),
  };
}

export function projectThreadExcerpt(
  thread: EnvironmentThreadShell,
  report?: string,
): string | null {
  const latestMessage = thread.source.latestVisibleMessage;
  const text = report ?? (latestMessage?.role === "assistant" ? latestMessage.text : null);
  if (!text?.trim()) return null;
  const clean = text
    .trim()
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/\s+/gu, " ");
  if (clean.length <= 420) return clean;
  const cut = clean.lastIndexOf(" ", 420);
  return `${clean.slice(0, cut > 320 ? cut : 420)}…`;
}
