import type { HelpContext, HelpMessage } from "@t3tools/contracts";

/** Best-effort protection for accidentally pasted credentials; never a reason to collect more. */
export function redactHelpText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
      "[private key removed]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [redacted]")
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/giu,
      "$1[redacted]",
    )
    .replace(
      /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/gu,
      "[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(
      /(\b(?:[a-z][a-z0-9]*[_-])*(?:api[_ -]?key|management[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret[_ -]?access[_ -]?key|session[_ -]?token|password|passwd|secret|token|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/giu,
      "$1[redacted]",
    )
    .replace(/((?:https?|wss?):\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(
      /([?&#](?:[a-z][a-z0-9]*[_-])*(?:code|[a-z]*token|key|api[_-]?key|client[_-]?secret|credential|sig|signature)=)[^\s&#"'<>`]+/giu,
      "$1[redacted]",
    );
}

/** Snapshot values are used only to remove private text, never attached to the report. */
function reportRedactions(context: HelpContext | null): readonly (readonly [string, string])[] {
  const redactions = new Map<string, string>();
  const add = (value: string, replacement: string) => {
    if (!value || value === "/" || value === "\\") return;
    redactions.set(value, replacement);
    redactions.set(JSON.stringify(value).slice(1, -1), replacement);
  };
  const isAppRoute = (value: string) => /^\/(?:settings|help)(?:[/?#]|$)/u.test(value);
  const isLocalPath = (value: string) =>
    /^(?:\/(?!\/)|\\\\|~[\\/]|[a-z]:[\\/]|file:\/\/|%[^%\r\n]+%[\\/]|\$(?:\{\w+\}|\w+)[\\/])/iu.test(
      value,
    ) && !isAppRoute(value);
  const visit = (value: unknown, key = "", depth = 0, setting = false): void => {
    if (depth > 12) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key, depth + 1, setting);
    } else if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const [property, entry] of Object.entries(record)) {
        const isSettingValue = property === "value" && typeof record.key === "string";
        visit(
          entry,
          isSettingValue ? (record.key as string) : property,
          depth + 1,
          setting || isSettingValue,
        );
      }
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        /(?:api[_-]?key|management[_-]?key|token|secret|password|passwd|authorization|cookie|credential)/iu.test(
          key,
        ) &&
        !/^(?:configured|missing|configured \(value omitted\)|not configured)$/iu.test(trimmed)
      ) {
        add(value, "[redacted]");
      }
      if (/^(?:\[|\{|")/u.test(trimmed)) {
        try {
          const decoded: unknown = JSON.parse(trimmed);
          if (decoded !== null && typeof decoded === "object")
            add(value, "[configuration removed]");
          visit(decoded, key, depth + 1, setting);
        } catch {
          // Human-readable snapshot values are not necessarily JSON.
        }
      }
      if (
        isLocalPath(trimmed) ||
        (setting &&
          /(?:path|director(?:y|ies)|userDataDir|executable|home)(?:$|[.[])/iu.test(key) &&
          /[\\/]/u.test(trimmed) &&
          !/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) &&
          !isAppRoute(trimmed))
      ) {
        add(trimmed, "[local path]");
      }
      for (const match of value.matchAll(
        /(["'`])((?:[a-z]:[\\/]|\\\\|~[\\/]|\/(?!\/))[^\r\n]*?)\1/giu,
      )) {
        if (!isAppRoute(match[2]!)) add(match[2]!, "[local path]");
      }
      for (const match of value.matchAll(
        /(?:^|[\s(=])((?:[a-z]:[\\/]|\\\\|~[\\/]|\/(?!\/))[^\s<>"'`),;]+)/giu,
      )) {
        if (!isAppRoute(match[1]!)) add(match[1]!, "[local path]");
      }
    }
  };
  for (const { path } of context?.paths ?? []) add(path, "[local path]");
  visit(context?.knowledge);
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- HelpContext.client is a support snapshot, not an RPC client.
  visit(context?.client);
  return [...redactions].sort(([a], [b]) => b.length - a.length);
}

function publicReportText(
  text: string,
  redactions: readonly (readonly [string, string])[] = [],
): string {
  const withoutSnapshotValues = redactions.reduce(
    (value, [privateValue, replacement]) => value.split(privateValue).join(replacement),
    text,
  );
  return redactHelpText(withoutSnapshotValues)
    .replace(/(["'\x60])\\{2,}[^\\\s<>"'\x60]+\\[^\r\n]*?\1/gu, "$1[local path]$1")
    .replace(/\\{2,}[^\\\s<>"'\x60]+\\[^\r\n<>"'\x60,;]*/gu, "[local path]")
    .replace(
      /(["'`])(?:[A-Z]:[\\/]|\/(?:Users|home|private|var|tmp|Applications|opt|Volumes|root|srv|etc|mnt|media|run|usr|workspace|workspaces|data|app)\/)[^\r\n]*?\1/giu,
      "$1[local path]$1",
    )
    .replace(/\b[A-Z]:[\\/](?:[^\s<>"'`]+|[^\r\n"'`]*?(?=["'`]))/giu, "[local path]")
    .replace(
      /\/(?:Users|home|private|var|tmp|Applications|opt|Volumes|root|srv|etc|mnt|media|run|usr|workspace|workspaces|data|app)\/[^\s<>"'`]+/gu,
      "[local path]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email removed]")
    .slice(0, 4_000)
    .trim();
}

/** The preview is also the exact copy/download payload. Host paths are omitted; chat is opt-in. */
export function buildHelpReport(input: {
  readonly context: HelpContext | null;
  readonly summary: string;
  readonly steps: string;
  readonly expected: string;
  readonly actual: string;
  readonly conversation: readonly HelpMessage[];
  readonly includeConversation: boolean;
}): string {
  const context = input.context;
  const redactions = reportRedactions(context);
  const publicText = (value: string) => publicReportText(value, redactions);
  const reportField = (value: string) => publicText(value) || "Not provided.";
  const environment = context
    ? [
        `App version: ${publicText(context.version)}`,
        `Platform: ${publicText(context.platform)}`,
        `Surface: ${publicText(context.mode)}`,
        `Providers (reported status): ${
          context.providers
            .slice(0, 12)
            .map(
              (provider) =>
                `${publicText(provider.driver)}: ${publicText(provider.status)}${provider.enabled ? "" : " (disabled)"}`,
            )
            .join(", ") || "None reported"
        }`,
        `Diagnostic sample: ${context.diagnostics.recordCount} records, ${context.diagnostics.failureCount} failures, ${context.diagnostics.slowSpanCount} slow operations. ${context.diagnostics.partial ? "Incomplete sample." : "Historical sample; not a live health check."}`,
        `Snapshot captured: ${publicText(context.capturedAt)}`,
      ].join("\n")
    : "App context unavailable. Basic recovery and report preparation remain available.";

  const sections = [
    "# TritonAI feedback",
    `## Summary\n${reportField(input.summary)}`,
    `## Steps to reproduce\n${reportField(input.steps)}`,
    `## Expected behavior\n${reportField(input.expected)}`,
    `## Actual behavior\n${reportField(input.actual)}`,
    `## App information\n${environment}`,
  ];
  if (input.includeConversation && input.conversation.length > 0) {
    const messages: string[] = [];
    let remaining = 16_000;
    for (const message of input.conversation.slice(-20).toReversed()) {
      const entry = `### ${message.role === "user" ? "You" : "Help"}\n${publicText(message.content)}`;
      const separatorLength = messages.length > 0 ? 2 : 0;
      if (entry.length + separatorLength > remaining) break;
      messages.unshift(entry);
      remaining -= entry.length + separatorLength;
    }
    sections.push(`## Help conversation (included by choice)\n${messages.join("\n\n")}`);
  }
  sections.push(
    "Prepared locally. No raw logs, configuration values, or project conversations attached. Review before sharing.",
  );
  return sections.join("\n\n");
}
