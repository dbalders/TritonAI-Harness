/** Defense in depth for support text; schema-declared secrets are removed before this step. */
export function redactHelpText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:[a-z][a-z0-9_]*_)?(?:api[_-]?key|management[_ -]?key|secret[_-]?access[_-]?key|access[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|secret|token)\s*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:code|token|key|api_key|access_token|sig|signature)=)[^\s&#]+/gi,
      "$1[REDACTED]",
    );
}

export function safeHelpText(value: string, limit: number): string {
  return (
    redactHelpText(value)
      // oxlint-disable-next-line no-control-regex -- Strip control characters from untrusted support text.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, limit)
  );
}

export function helpSettingRequested(key: string, question: string): boolean {
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const query = normalize(question);
  return key.split(/[.[\]]/).some((part) => part.length > 3 && query.includes(normalize(part)));
}
