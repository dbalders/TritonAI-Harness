// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the Promise-based registry owns this bounded child process and its kill timer.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

import {
  DOCUMENT_TEXT_MAX_CHARACTERS,
  DOCUMENT_TEXT_MAX_INPUT_BYTES,
  isDocumentTextFormat,
  type DocumentTextFailureReason,
  type DocumentTextFormat,
  type DocumentTextResult,
} from "./documentText/DocumentTextExtraction.ts";

export type {
  DocumentTextFormat,
  DocumentTextResult,
} from "./documentText/DocumentTextExtraction.ts";

export interface DocumentTextRequest {
  readonly format: DocumentTextFormat;
  readonly bytes: Uint8Array;
  /** At most DOCUMENT_TEXT_MAX_CHARACTERS; the provider usually asks for less to fit its result. */
  readonly maxCharacters?: number;
}

/** Host facility offered to read invocations as `context.extractDocumentText`. */
export type IntegrationDocumentTextExtractor = (
  request: DocumentTextRequest,
  signal: AbortSignal,
) => Promise<DocumentTextResult>;

export interface DocumentTextWorkerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Node and Electron-as-node honor argument limits; packaged Electron ignores NODE_OPTIONS.
   * Single executables have no runtime-flag position and use NODE_OPTIONS instead.
   * The worker verifies effective limits before parsing.
   */
  readonly limitsVia?: "arguments" | "environment";
}

const DOCUMENT_TEXT_TIMEOUT_MS = 15_000;
const DOCUMENT_TEXT_HEAP_MB = 256;
const MAX_WORKER_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONCURRENT_EXTRACTIONS = 2;
const MAX_QUEUED_EXTRACTIONS = 8;

/**
 * The extractor is this server's own CLI with the `__document-text` fast path in bin.ts. A
 * single executable is its own entry; otherwise argv[1] is the server entry under node or
 * Electron-as-node. Any other launcher (a test runner, an embedding host) gets no extractor
 * rather than an arbitrary script.
 */
export function resolveDocumentTextWorkerCommand(): DocumentTextWorkerCommand | null {
  if (NodeSea.isSea()) {
    return {
      command: process.execPath,
      args: ["__integration-document-text"],
      limitsVia: "environment",
    };
  }
  const entry = process.argv[1];
  if (!entry || !/^bin\.(?:m?js|ts)$/u.test(NodePath.basename(entry))) return null;
  return { command: process.execPath, args: [entry, "__integration-document-text"] };
}

function failed(
  format: DocumentTextFormat,
  reason: DocumentTextFailureReason,
  message: string,
): DocumentTextResult {
  return { status: "failed", format, reason, message };
}

// Clear the child environment, cap the V8 heap, and disable string code generation.
// The worker verifies both limits; a wall-clock kill bounds hangs.
// This does not cap total RSS or provide an OS sandbox.
function workerLimitFlags(heapMb: number): Array<string> {
  return [`--max-old-space-size=${heapMb}`, "--disallow-code-generation-from-strings"];
}

function workerEnvironment(heapMb: number, viaEnvironment: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = viaEnvironment
    ? { NODE_OPTIONS: workerLimitFlags(heapMb).join(" ") }
    : {};
  for (const name of ["ELECTRON_RUN_AS_NODE", "SystemRoot", "SYSTEMROOT", "windir"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function parseWorkerResult(
  output: string,
  format: DocumentTextFormat,
  maxCharacters: number,
): DocumentTextResult | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.format !== format) return null;
  if (record.status === "failed") {
    return typeof record.reason === "string" && typeof record.message === "string"
      ? failed(format, record.reason as DocumentTextFailureReason, record.message.slice(0, 500))
      : null;
  }
  if (
    record.status !== "extracted" ||
    typeof record.text !== "string" ||
    record.text.length > maxCharacters ||
    typeof record.truncated !== "boolean"
  ) {
    return null;
  }
  const count = (key: string) => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : undefined;
  };
  const pageCount = count("pageCount");
  const pagesRead = count("pagesRead");
  return {
    status: "extracted",
    format,
    text: record.text,
    truncated: record.truncated,
    ...(pageCount === undefined ? {} : { pageCount }),
    ...(pagesRead === undefined ? {} : { pagesRead }),
    ...(record.containsMacros === true ? { containsMacros: true } : {}),
  };
}

function runWorker(
  command: DocumentTextWorkerCommand,
  request: DocumentTextRequest,
  maxCharacters: number,
  signal: AbortSignal,
  limits: { readonly timeoutMs: number; readonly heapMb: number },
): Promise<DocumentTextResult> {
  const { format } = request;
  return new Promise((resolve) => {
    let settled = false;
    let child: NodeChildProcess.ChildProcess | undefined;
    const chunks: Array<Buffer> = [];
    let outputBytes = 0;
    const finish = (result: DocumentTextResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve(result);
    };
    const onAbort = () => finish(failed(format, "cancelled", "Text extraction was cancelled."));
    const timer = setTimeout(
      () =>
        finish(
          failed(
            format,
            "timeout",
            `Text extraction was stopped after ${Math.round(limits.timeoutMs / 1000)} seconds.`,
          ),
        ),
      limits.timeoutMs,
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const viaEnvironment = command.limitsVia === "environment";
    try {
      child = NodeChildProcess.spawn(
        command.command,
        [
          ...(viaEnvironment ? [] : workerLimitFlags(limits.heapMb)),
          ...command.args,
          format,
          String(maxCharacters),
          String(limits.heapMb),
        ],
        {
          env: workerEnvironment(limits.heapMb, viaEnvironment),
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch {
      finish(failed(format, "unavailable", "Harness could not start its document text extractor."));
      return;
    }
    child.on("error", () =>
      finish(failed(format, "unavailable", "Harness could not start its document text extractor.")),
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_WORKER_OUTPUT_BYTES) {
        finish(failed(format, "resource_limit", "Text extraction produced too much output."));
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      const result =
        code === 0
          ? parseWorkerResult(Buffer.concat(chunks).toString("utf8"), format, maxCharacters)
          : null;
      finish(
        result ??
          failed(
            format,
            "resource_limit",
            "Text extraction stopped before finishing; the document exceeded the extractor's memory or processing limits.",
          ),
      );
    });
    // The child may exit before reading everything (for example, an oversized input).
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(
      Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength),
    );
  });
}

/**
 * Runs each extraction in a fresh, killable process with a JavaScript heap cap and a wall-clock
 * limit, so a hostile document cannot block the server or exhaust its heap. Results are never retried automatically:
 * the same bytes fail the same way.
 */
export function makeDocumentTextExtractor(
  options: {
    readonly resolveCommand?: () => DocumentTextWorkerCommand | null;
    readonly timeoutMs?: number;
    readonly heapMb?: number;
    readonly maxConcurrent?: number;
  } = {},
): IntegrationDocumentTextExtractor {
  const resolveCommand = options.resolveCommand ?? resolveDocumentTextWorkerCommand;
  const limits = {
    timeoutMs: options.timeoutMs ?? DOCUMENT_TEXT_TIMEOUT_MS,
    heapMb: options.heapMb ?? DOCUMENT_TEXT_HEAP_MB,
  };
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_EXTRACTIONS;
  let running = 0;
  const waiting: Array<() => void> = [];
  // A finished extraction hands its slot straight to the next waiter.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  return async (request, signal) => {
    const format = request.format;
    if (!isDocumentTextFormat(format)) throw new Error("Unsupported document text format.");
    if (!(request.bytes instanceof Uint8Array)) throw new Error("Document bytes are required.");
    if (request.bytes.byteLength > DOCUMENT_TEXT_MAX_INPUT_BYTES) {
      return failed(format, "too_large", "The document is too large to extract.");
    }
    const requested = request.maxCharacters ?? DOCUMENT_TEXT_MAX_CHARACTERS;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw new Error("maxCharacters must be a positive integer.");
    }
    const maxCharacters = Math.min(requested, DOCUMENT_TEXT_MAX_CHARACTERS);
    const command = resolveCommand();
    if (!command) {
      return failed(
        format,
        "unavailable",
        "Document text extraction is unavailable in this Harness runtime.",
      );
    }
    if (signal.aborted) return failed(format, "cancelled", "Text extraction was cancelled.");
    if (running >= maxConcurrent) {
      if (waiting.length >= MAX_QUEUED_EXTRACTIONS) {
        return failed(format, "busy", "Too many documents are being extracted. Try again shortly.");
      }
      const admitted = await new Promise<boolean>((resolve) => {
        const admit = () => {
          signal.removeEventListener("abort", cancel);
          resolve(true);
        };
        const cancel = () => {
          const index = waiting.indexOf(admit);
          if (index >= 0) waiting.splice(index, 1);
          resolve(false);
        };
        waiting.push(admit);
        signal.addEventListener("abort", cancel, { once: true });
      });
      if (!admitted) return failed(format, "cancelled", "Text extraction was cancelled.");
    } else {
      running += 1;
    }
    try {
      return await runWorker(command, request, maxCharacters, signal, limits);
    } finally {
      release();
    }
  };
}
