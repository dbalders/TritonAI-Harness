/** A published note's title, from the `# Title` line `formatTeamNote` writes first. */
export function teamNoteTitle(text: string, path: string): string {
  const heading = /^# (.+)$/mu.exec(text.split("\n", 1)[0] ?? "")?.[1]?.trim();
  return heading || path.split("/").at(-1) || path;
}

/**
 * Wraps a team note for the user's message. The block names its team and note so the
 * conversation records where the text came from; a closing tag inside the note cannot end it early.
 */
export function formatTeamMemoryContext(input: {
  teamName: string;
  path: string;
  text: string;
}): string {
  const attribute = (value: string) => value.replace(/["<>\r\n]/gu, " ");
  return [
    `<team-memory team="${attribute(input.teamName)}" note="${attribute(input.path)}">`,
    input.text.replace(/<\/team-memory>/giu, "<\\/team-memory>"),
    "</team-memory>",
  ].join("\n");
}
