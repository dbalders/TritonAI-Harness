/** The most text one shared note may hold, as the share command accepts it. */
const MAX_SHARE_TEXT_CHARS = 60_000;
/** The most a shared note may take once formatted, as shared storage accepts it. */
const MAX_SHARE_NOTE_BYTES = 64 * 1024;

/** Why a note can't be shared as written, or null when it can. */
export function shareLimitProblem(input: { readonly text: string; readonly note: string }) {
  if (input.text.length > MAX_SHARE_TEXT_CHARS)
    return `Shared text can be at most 60,000 characters; this has ${input.text.length.toLocaleString("en-US")}.`;
  if (new TextEncoder().encode(input.note).byteLength > MAX_SHARE_NOTE_BYTES)
    return "Shared notes must be smaller than 64 KB.";
  return null;
}
