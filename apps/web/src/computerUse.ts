export function isComputerUseRequest(text: string): boolean {
  return /^(?:\/computer-use(?:\s|$)|(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?use\s+computer[ -]use\b)/i.test(
    text.trim(),
  );
}

export function isBareComputerUseRequest(text: string): boolean {
  return /^\s*\/computer-use\s*$/i.test(text);
}

export function computerUsePrompt(text: string): string {
  if (isBareComputerUseRequest(text))
    return "Check whether computer use is ready in this environment and explain any setup needed.";
  return text.replace(/^\s*\/computer-use(?:\s+|$)/i, "Use computer use to ");
}

/** Bound the composer preflight even if the desktop IPC request never settles. */
export async function readComputerUseStateWithTimeout<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Computer-use status check timed out. Try again or open Settings > General to check the desktop connection.",
              ),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
