// @effect-diagnostics nodeBuiltinImport:off - a plain stdin/stdout worker process with no Effect runtime.
import * as NodeV8 from "node:v8";

import {
  DOCUMENT_TEXT_MAX_INPUT_BYTES,
  extractDocumentTextInProcess,
  isDocumentTextFormat,
  type DocumentTextResult,
} from "./DocumentTextExtraction.ts";

// V8's reported heap limit is the old-space cap plus young-generation and other spaces (about
// 100-200 MiB more on current node and Electron); an uncapped process reports gigabytes.
const HEAP_LIMIT_ALLOWANCE_MB = 512;

/**
 * True only when this process observably runs with the requested JavaScript heap cap and refuses
 * code generation from strings. Launchers can drop runtime flags (packaged Electron ignores
 * NODE_OPTIONS), so the worker checks the effect rather than trusting how it was started.
 */
export function documentTextWorkerLimitsInEffect(heapMb: number): boolean {
  if (!Number.isSafeInteger(heapMb) || heapMb < 1) return false;
  const heapLimitMb = NodeV8.getHeapStatistics().heap_size_limit / (1024 * 1024);
  if (heapLimitMb > heapMb + HEAP_LIMIT_ALLOWANCE_MB) return false;
  try {
    new Function("return 1");
    return false;
  } catch (error) {
    return error instanceof EvalError;
  }
}

/**
 * Entry for `t3 __document-text <format> <max-characters> <heap-mb>`: reads one document from
 * stdin and writes one JSON result line to stdout. bin.ts dispatches here before the CLI module
 * graph loads, so the process starts quickly and holds no server state or credentials.
 */
export async function runDocumentTextWorker(args: ReadonlyArray<string>): Promise<void> {
  const [format, rawMaxCharacters, rawHeapMb] = args;
  if (!isDocumentTextFormat(format)) {
    process.exitCode = 2;
    return;
  }
  if (!documentTextWorkerLimitsInEffect(Number(rawHeapMb))) {
    write({
      status: "failed",
      format,
      reason: "unavailable",
      message:
        "Document text extraction is unavailable because this Harness runtime could not apply the extractor's memory and code limits.",
    });
    return;
  }
  const chunks: Array<Buffer> = [];
  let total = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > DOCUMENT_TEXT_MAX_INPUT_BYTES) {
      write({
        status: "failed",
        format,
        reason: "too_large",
        message: "The document is too large to extract.",
      });
      return;
    }
    chunks.push(chunk);
  }
  const maxCharacters = Number.parseInt(rawMaxCharacters ?? "", 10);
  write(
    await extractDocumentTextInProcess({
      format,
      bytes: Buffer.concat(chunks),
      ...(Number.isSafeInteger(maxCharacters) ? { maxCharacters } : {}),
    }),
  );
}

function write(result: DocumentTextResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
