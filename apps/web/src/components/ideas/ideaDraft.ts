/**
 * The composer text after opening an idea's draft. An empty composer takes the
 * idea's prompt; text the user already typed stays first, and opening the same
 * idea twice does not paste it twice.
 */
export function mergeIdeaPrompt(existing: string, prompt: string): string {
  if (existing.trim().length === 0) return prompt;
  if (existing.includes(prompt)) return existing;
  return `${existing.trimEnd()}\n\n${prompt}`;
}
