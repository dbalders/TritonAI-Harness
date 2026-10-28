import * as NodeV8 from "node:v8";
import { offlineHtmlPreview } from "./HtmlPreviewPolicy.ts";
import { HTML_PREVIEW_MAX_INPUT_BYTES } from "./HtmlPreview.ts";

// Trusted parser isolation protects server responsiveness; this is not an OS sandbox.
export async function runHtmlPreviewWorker(args: ReadonlyArray<string>): Promise<void> {
  const heapMb = Number(args[0]);
  if (heapMb !== 256 || NodeV8.getHeapStatistics().heap_size_limit > (heapMb + 512) * 1024 * 1024) {
    process.exitCode = 2;
    return;
  }
  try {
    new Function("return 1")();
    process.exitCode = 2;
    return;
  } catch (error) {
    if (!(error instanceof EvalError)) throw error;
  }
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > HTML_PREVIEW_MAX_INPUT_BYTES) {
      process.exitCode = 2;
      return;
    }
    chunks.push(chunk);
  }
  const result = offlineHtmlPreview(Buffer.concat(chunks).toString("utf8"));
  const headers = JSON.stringify(result.headers);
  if (Buffer.byteLength(result.html) + headers.length + 1 > HTML_PREVIEW_MAX_INPUT_BYTES * 2) {
    process.exitCode = 2;
    return;
  }
  process.stdout.write(headers + "\n");
  process.stdout.write(result.html);
}
