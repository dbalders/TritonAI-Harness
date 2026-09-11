export function isComputerUseRequest(text: string): boolean {
  return /^(?:\/computer-use(?:\s|$)|(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?use\s+computer[ -]use\b)/i.test(
    text.trim(),
  );
}

export function computerUsePrompt(text: string): string {
  if (/^\s*\/computer-use\s*$/i.test(text))
    return "Check whether computer use is ready in this environment and explain any setup needed.";
  return text.replace(/^\s*\/computer-use(?:\s+|$)/i, "Use computer use to ");
}
