const MAX_SUMMARY_CHARS = 600;
const MAX_ARGUMENT_LINES = 8;
const MAX_VALUE_CHARS = 120;
const SECRET_ARGUMENT = /secret|password|passphrase|token|api[-_]?key|credential/iu;

function oneLine(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function describeValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = oneLine(value);
    if (!text) return undefined;
    return text.length <= MAX_VALUE_CHARS
      ? JSON.stringify(text)
      : `${JSON.stringify(text.slice(0, MAX_VALUE_CHARS))}… (${value.length} characters)`;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : bounded(json, MAX_VALUE_CHARS);
  } catch {
    return "[unreadable value]";
  }
}

/**
 * Describe actual tool arguments in bounded lines; redact secret-looking values before persistence.
 * A nonempty summary replaces arguments only when the write tool validates it exactly
 * against its planned change (see docs/integrations.md).
 */
export function describeToolCallForApproval(toolName: string, args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return toolName;
  const record = args as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? oneLine(record.summary) : "";
  if (summary) return `${toolName}\n${bounded(summary, MAX_SUMMARY_CHARS)}`;

  const lines: string[] = [];
  let omitted = 0;
  for (const [name, value] of Object.entries(record)) {
    const described = SECRET_ARGUMENT.test(name) ? "[hidden]" : describeValue(value);
    if (described === undefined) continue;
    if (lines.length >= MAX_ARGUMENT_LINES) {
      omitted += 1;
      continue;
    }
    lines.push(`${name}: ${described}`);
  }
  if (omitted > 0) lines.push(`+${omitted} more`);
  return lines.length === 0 ? toolName : [toolName, ...lines].join("\n");
}
