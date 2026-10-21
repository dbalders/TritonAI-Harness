// @effect-diagnostics nodeBuiltinImport:off - a plain stdin/stdout worker process with no Effect runtime.
import {
  DOCUMENT_TEXT_MAX_INPUT_BYTES,
  extractDocumentTextInProcess,
  isDocumentTextFormat,
  type DocumentTextResult,
} from "./DocumentTextExtraction.ts";

/**
 * Entry for `t3 __document-text <format> <max-characters>`: reads one document from stdin and
 * writes one JSON result line to stdout. bin.ts dispatches here before the CLI module graph loads,
 * so the process starts quickly and holds no server state or credentials.
 */
export async function runDocumentTextWorker(args: ReadonlyArray<string>): Promise<void> {
  const [format, rawMaxCharacters] = args;
  if (!isDocumentTextFormat(format)) {
    process.exitCode = 2;
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
