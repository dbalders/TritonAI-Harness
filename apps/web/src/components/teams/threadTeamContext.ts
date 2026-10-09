import type { TeamContextKind, TeamDocumentSummary } from "@t3tools/contracts";

/**
 * Who a team document's folder belongs to: `Memory|Skills/<author>/<device>/<record>.md`. Names
 * come from the server's current member list, so a former member has none.
 */
export function teamDocumentAuthor(
  path: string,
  authors: Readonly<Record<string, string>> | undefined,
): string {
  const author = path.split("/")[1] ?? "";
  return authors?.[author] ?? "a former member";
}

/** A listed memory note or skill, with the summary the server or a preview read from it. */
export interface TeamListedDocument {
  readonly path: string;
  readonly summary?: TeamDocumentSummary | undefined;
}

export interface TeamContextRow {
  readonly path: string;
  readonly label: string;
  readonly description: string;
  /** Author provenance, with the record id when the label alone can't tell two rows apart. */
  readonly source: string;
  readonly warning: string | null;
}

const nouns = { memory: "note", skill: "skill" } as const;

/**
 * Rows for choosing a team document: titled ones first, then the rest. A document not summarized
 * yet is named by a short record id until it is previewed.
 */
export function teamContextRows(
  kind: TeamContextKind,
  files: readonly TeamListedDocument[],
  authors: Readonly<Record<string, string>> | undefined,
): TeamContextRow[] {
  const noun = nouns[kind];
  const rows = files.map((file) => {
    const id = (file.path.split("/").at(-1) ?? "").slice(0, 8);
    const summary = file.summary;
    const label = summary
      ? summary.title || `Untitled ${noun}`
      : `${noun[0]!.toUpperCase()}${noun.slice(1)} ${id}`;
    return {
      path: file.path,
      id,
      titled: Boolean(summary?.title),
      label,
      description: summary
        ? summary.description || (kind === "skill" ? "No description" : "")
        : "Preview to see its title.",
      author: teamDocumentAuthor(file.path, authors),
      warning:
        kind === "skill" && summary?.hidden
          ? "Contains hidden or control characters, so Harness won’t use it."
          : summary?.hidden && !summary.title
            ? "Its title isn’t shown because it contains hidden characters."
            : null,
    };
  });
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.label}\n${row.author}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return rows
    .toSorted((a, b) =>
      a.titled !== b.titled
        ? a.titled
          ? -1
          : 1
        : a.label.localeCompare(b.label) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .map((row) => ({
      path: row.path,
      label: row.label,
      description: row.description,
      source:
        (seen.get(`${row.label}\n${row.author}`) ?? 0) > 1
          ? `From ${row.author} · ${row.id}`
          : `From ${row.author}`,
      warning: row.warning,
    }));
}
