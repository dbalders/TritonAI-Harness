/** A published note's title, from the `# Title` line `formatTeamNote` writes first. */
export function teamNoteTitle(text: string, path: string): string {
  const heading = /^# (.+)$/mu.exec(text.split("\n", 1)[0] ?? "")?.[1]?.trim();
  return heading || path.split("/").at(-1) || path;
}

/**
 * The description and project label `formatTeamNote` writes under a document's title. Anyone
 * who can edit the document can change these lines, so they describe it rather than vouch for it.
 */
export function teamNoteDetails(text: string): { description: string; project: string } {
  const lines = text.split("\n\n").slice(1, 3);
  const field = (name: string) =>
    lines
      .find((line) => line.startsWith(`${name}: `) && !line.includes("\n"))
      ?.slice(name.length + 2)
      .trim() ?? "";
  return { description: field("Description"), project: field("Project") };
}

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
