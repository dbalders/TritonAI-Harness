import type { BotTaskResult } from "@t3tools/contracts";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
const shortText = (value: unknown, length: number) =>
  typeof value === "string" ? value.trim().slice(0, length) : "";
function reference(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.toString().length <= 2048
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse reported evidence separately from the execution receipt supplied by the worker. */
export function taskResultEvidence(
  text: string,
  execution: BotTaskResult["execution"],
): BotTaskResult {
  const block = /```bot-result\s*\n([\s\S]*?)\n```/u.exec(text);
  let reported: Record<string, unknown> | undefined;
  if (block && block[1]!.length <= 30_000) {
    try {
      reported = object(JSON.parse(block[1]!) as unknown);
    } catch {
      /* A malformed optional report never changes whether the actual turn finished. */
    }
  }
  const artifacts: Array<BotTaskResult["artifacts"][number]> = [];
  if (Array.isArray(reported?.artifacts)) {
    for (const raw of reported.artifacts.slice(0, 20)) {
      const item = object(raw),
        uri = reference(item?.uri),
        label = shortText(item?.label, 240);
      if (uri && label)
        artifacts.push({
          uri,
          label,
          kind: item?.kind === "source" ? "source" : "artifact",
          provenance: "assistant-reported",
        });
    }
  }
  // Ordinary Markdown answers remain useful even when the provider ignores the optional envelope.
  for (const match of text.matchAll(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/gu)) {
    const uri = reference(match[2]);
    if (artifacts.length >= 20) break;
    if (uri && !artifacts.some((item) => item.uri === uri))
      artifacts.push({
        label: match[1]!.slice(0, 240),
        uri,
        kind: "source",
        provenance: "assistant-reported",
      });
  }
  const checks: Array<BotTaskResult["checks"][number]> = [];
  if (Array.isArray(reported?.checks)) {
    for (const raw of reported.checks.slice(0, 20)) {
      const item = object(raw),
        label = shortText(item?.label, 500);
      if (label)
        checks.push({
          label,
          status:
            item?.status === "reported-pass"
              ? "reported-pass"
              : item?.status === "reported-fail"
                ? "reported-fail"
                : "not-run",
          provenance: "assistant-reported",
        });
    }
  }
  const blockers = Array.isArray(reported?.blockers)
    ? reported.blockers
        .slice(0, 10)
        .map((item) => shortText(item, 500))
        .filter(Boolean)
    : [];
  return {
    version: 1,
    summary:
      shortText(reported?.summary, 4000) ||
      text
        .replace(/```bot-result\s*\n[\s\S]*?\n```/u, "")
        .trim()
        .slice(0, 4000) ||
      "Finished without a written reply.",
    execution,
    verification: { status: "unverified" },
    artifacts,
    checks,
    blockers,
  };
}
