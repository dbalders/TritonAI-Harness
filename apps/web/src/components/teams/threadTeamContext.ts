/** A published note's title, from the `# Title` line `formatTeamNote` writes first. */
export function teamNoteTitle(text: string, path: string): string {
  const heading = /^# (.+)$/mu.exec(text.split("\n", 1)[0] ?? "")?.[1]?.trim();
  return heading || path.split("/").at(-1) || path;
}
