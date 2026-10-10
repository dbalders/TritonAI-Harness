import type { TeamDocumentChange, TeamDocumentSummary } from "@t3tools/contracts";

/**
 * Who a team document's folder belongs to: `Memory|SOPs|Skills/<author>/<device>/<record>.md`. Names
 * come from the server's current member list, so a former member has none.
 */
export function teamDocumentAuthor(
  path: string,
  authors: Readonly<Record<string, string>> | undefined,
): string {
  const author = path.split("/")[1] ?? "";
  return authors?.[author] ?? "a former member";
}

/**
 * Who last saved a document or version and when, as shared storage recorded it. The name is the
 * Microsoft account's, and may differ from the member name shown for the document's folder.
 */
export function teamDocumentChange(change: TeamDocumentChange | undefined): string {
  if (!change) return "Not recorded";
  const at = new Date(change.at);
  return `${change.by}, ${at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

/** A listed team document, with the summary the server or a preview read from it. */
export interface TeamListedDocument {
  readonly path: string;
  readonly summary?: TeamDocumentSummary | undefined;
}

/** The kind of a team document, from the top-level folder it is saved in. */
export type TeamDocumentKind = "memory" | "sop" | "skill";
const roots: Readonly<Record<string, TeamDocumentKind>> = {
  Memory: "memory",
  SOPs: "sop",
  Skills: "skill",
};
export const teamDocumentKind = (path: string): TeamDocumentKind =>
  roots[path.split("/", 1)[0] ?? ""] ?? "memory";

/** What a team document is called where documents of every kind are listed together. */
export const teamDocumentKindLabels = {
  memory: "Work summary",
  sop: "SOP",
  skill: "Skill document",
} as const satisfies Record<TeamDocumentKind, string>;

export interface TeamDocumentRow {
  readonly path: string;
  readonly kind: TeamDocumentKind;
  readonly label: string;
  readonly description: string;
  /** Author provenance, with the record id when the label alone can't tell two rows apart. */
  readonly source: string;
  /** The document's project label, empty when it has none or wasn't summarized. */
  readonly project: string;
  readonly warning: string | null;
  /** What `filterTeamDocumentRows` matches: kind, title, description, author, and project label. */
  readonly search: string;
}

const nouns = { memory: "note", sop: "SOP", skill: "skill" } as const;

/** Lowercase, accent-free text, so "resume" finds "Résumé". */
const searchable = (value: string) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/**
 * Rows for choosing a team document: titled ones first, then the rest. A document not summarized
 * yet is named by a short record id until it is previewed.
 */
export function teamDocumentRows(
  files: readonly TeamListedDocument[],
  authors: Readonly<Record<string, string>> | undefined,
): TeamDocumentRow[] {
  const rows = files.map((file) => {
    const kind = teamDocumentKind(file.path);
    const noun = nouns[kind];
    const id = (file.path.split("/").at(-1) ?? "").slice(0, 8);
    const summary = file.summary;
    const label = summary
      ? summary.title || `Untitled ${noun}`
      : `${noun[0]!.toUpperCase()}${noun.slice(1)} ${id}`;
    const author = teamDocumentAuthor(file.path, authors);
    const project = summary?.project ?? "";
    return {
      path: file.path,
      kind,
      id,
      titled: Boolean(summary?.title),
      label,
      description: summary
        ? summary.description || (kind === "skill" ? "No description" : "")
        : "Preview to see its title.",
      author,
      project,
      warning:
        kind === "skill" && summary?.hidden
          ? "Contains hidden or control characters, so Harness won’t use it."
          : summary?.hidden && !summary.title
            ? "Its title isn’t shown because it contains hidden characters."
            : null,
      search: searchable(
        [teamDocumentKindLabels[kind], label, summary?.description ?? "", author, project].join(
          "\n",
        ),
      ),
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
      kind: row.kind,
      label: row.label,
      description: row.description,
      source:
        (seen.get(`${row.label}\n${row.author}`) ?? 0) > 1
          ? `From ${row.author} · ${row.id}`
          : `From ${row.author}`,
      project: row.project,
      warning: row.warning,
      search: row.search,
    }));
}

/**
 * The rows matching every word of a search, in their listed order; all rows for a blank search.
 * Runs on the already-listed rows, so typing never contacts the team's storage.
 */
export function filterTeamDocumentRows<Row extends Pick<TeamDocumentRow, "search">>(
  rows: readonly Row[],
  query: string,
): readonly Row[] {
  const words = searchable(query).split(/\s+/u).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) => words.every((word) => row.search.includes(word)));
}
