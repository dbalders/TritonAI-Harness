// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - exercises a real child process and its wall-clock limit.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { makeDocx, makePdf } from "./documentText/DocumentTextFixtures.testkit.ts";
import {
  makeDocumentTextExtractor,
  resolveDocumentTextWorkerCommand,
  type DocumentTextWorkerCommand,
} from "./IntegrationDocumentText.ts";

const serverEntry = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const realWorker: DocumentTextWorkerCommand = {
  command: process.execPath,
  args: [serverEntry, "__document-text"],
};
const scriptWorker = (script: string): DocumentTextWorkerCommand => ({
  command: process.execPath,
  args: ["-e", script],
});
const signal = () => new AbortController().signal;
const temporaryDirectories: Array<string> = [];
function pidFile(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "document-text-"));
  temporaryDirectories.push(directory);
  return NodePath.join(directory, "pid");
}
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitForPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (NodeFS.existsSync(path)) return Number(NodeFS.readFileSync(path, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("worker did not start");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("isolated document text extraction", () => {
  it("extracts PDF and DOCX text through the server's own __document-text process", async () => {
    const extract = makeDocumentTextExtractor({ resolveCommand: () => realWorker });
    await expect(
      extract({ format: "pdf", bytes: makePdf(["Synthetic canary 9X2-PDF"]) }, signal()),
    ).resolves.toMatchObject({
      status: "extracted",
      format: "pdf",
      text: "Synthetic canary 9X2-PDF",
    });
    await expect(
      extract({ format: "docx", bytes: makeDocx(["Synthetic canary 9X2-DOCX"]) }, signal()),
    ).resolves.toMatchObject({
      status: "extracted",
      format: "docx",
      text: "Synthetic canary 9X2-DOCX",
    });
    await expect(
      extract({ format: "pdf", bytes: new TextEncoder().encode("%PDF-1.4 broken") }, signal()),
    ).resolves.toMatchObject({ status: "failed", reason: "corrupt" });
  }, 30_000);

  it("gives the extractor a heap cap and none of the server's environment", async () => {
    process.env.TRITONAI_DOCUMENT_TEXT_TEST_SECRET = "must-not-leak";
    try {
      const extract = makeDocumentTextExtractor({
        heapMb: 96,
        resolveCommand: () =>
          scriptWorker(
            `process.stdout.write(JSON.stringify({status:"extracted",format:"pdf",truncated:false,text:JSON.stringify(process.env)}))`,
          ),
      });
      const result = await extract({ format: "pdf", bytes: new Uint8Array([1]) }, signal());
      expect(result.status).toBe("extracted");
      const environment = JSON.parse(result.status === "extracted" ? result.text : "{}");
      expect(environment.TRITONAI_DOCUMENT_TEXT_TEST_SECRET).toBeUndefined();
      expect(environment.NODE_OPTIONS).toBe(
        "--max-old-space-size=96 --disallow-code-generation-from-strings",
      );
    } finally {
      delete process.env.TRITONAI_DOCUMENT_TEXT_TEST_SECRET;
    }
  });

  it("kills a worker stuck in synchronous code when the time limit passes", async () => {
    const path = pidFile();
    const extract = makeDocumentTextExtractor({
      timeoutMs: 400,
      resolveCommand: () =>
        scriptWorker(
          `require("node:fs").writeFileSync(${JSON.stringify(path)}, String(process.pid)); for (;;) {}`,
        ),
    });
    const started = Date.now();
    const pending = extract({ format: "docx", bytes: new Uint8Array([1]) }, signal());
    const pid = await waitForPid(path);
    await expect(pending).resolves.toMatchObject({ status: "failed", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    for (let attempt = 0; attempt < 100 && isRunning(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(isRunning(pid)).toBe(false);
  });

  it("reports a worker that exhausts its memory allowance", async () => {
    const extract = makeDocumentTextExtractor({
      heapMb: 32,
      resolveCommand: () =>
        scriptWorker("const keep = []; for (;;) keep.push(new Array(1e5).fill({ a: 1 }));"),
    });
    await expect(
      extract({ format: "pdf", bytes: new Uint8Array([1]) }, signal()),
    ).resolves.toMatchObject({ status: "failed", reason: "resource_limit" });
  }, 20_000);

  it("stops the worker when the invocation is cancelled", async () => {
    const path = pidFile();
    const controller = new AbortController();
    const extract = makeDocumentTextExtractor({
      resolveCommand: () =>
        scriptWorker(
          `require("node:fs").writeFileSync(${JSON.stringify(path)}, String(process.pid)); setInterval(() => {}, 1000);`,
        ),
    });
    const pending = extract({ format: "pdf", bytes: new Uint8Array([1]) }, controller.signal);
    const pid = await waitForPid(path);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "failed", reason: "cancelled" });
    for (let attempt = 0; attempt < 100 && isRunning(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(isRunning(pid)).toBe(false);
  });

  it("rejects oversized output, malformed output, and results over the character limit", async () => {
    const oversized = makeDocumentTextExtractor({
      resolveCommand: () => scriptWorker(`process.stdout.write("x".repeat(2 * 1024 * 1024))`),
    });
    await expect(
      oversized({ format: "pdf", bytes: new Uint8Array([1]) }, signal()),
    ).resolves.toMatchObject({ status: "failed", reason: "resource_limit" });
    const malformed = makeDocumentTextExtractor({
      resolveCommand: () => scriptWorker(`process.stdout.write("not json")`),
    });
    await expect(
      malformed({ format: "pdf", bytes: new Uint8Array([1]) }, signal()),
    ).resolves.toMatchObject({ status: "failed", reason: "resource_limit" });
    const tooLong = makeDocumentTextExtractor({
      resolveCommand: () =>
        scriptWorker(
          `process.stdout.write(JSON.stringify({status:"extracted",format:"pdf",truncated:false,text:"y".repeat(50)}))`,
        ),
    });
    await expect(
      tooLong({ format: "pdf", bytes: new Uint8Array([1]), maxCharacters: 10 }, signal()),
    ).resolves.toMatchObject({ status: "failed", reason: "resource_limit" });
  });

  it("refuses oversized input without starting a worker and reports a missing runtime", async () => {
    let started = 0;
    const extract = makeDocumentTextExtractor({
      resolveCommand: () => {
        started += 1;
        return realWorker;
      },
    });
    await expect(
      extract({ format: "pdf", bytes: new Uint8Array(8 * 1024 * 1024 + 1) }, signal()),
    ).resolves.toMatchObject({ status: "failed", reason: "too_large" });
    expect(started).toBe(0);
    await expect(
      makeDocumentTextExtractor({ resolveCommand: () => null })(
        { format: "docx", bytes: new Uint8Array([1]) },
        signal(),
      ),
    ).resolves.toMatchObject({ status: "failed", reason: "unavailable" });
    // A test runner is not the server entry, so the default resolver offers no extractor.
    expect(resolveDocumentTextWorkerCommand()).toBeNull();
  });

  it("returns an already-cancelled request at once without taking a queue slot", async () => {
    const blocker = new AbortController();
    const extract = makeDocumentTextExtractor({
      maxConcurrent: 1,
      resolveCommand: () => scriptWorker("setInterval(() => {}, 1000);"),
    });
    const running = extract({ format: "pdf", bytes: new Uint8Array([1]) }, blocker.signal);
    const aborted = new AbortController();
    aborted.abort();
    const started = Date.now();
    const cancelled = await Promise.all(
      Array.from({ length: 12 }, () =>
        extract({ format: "pdf", bytes: new Uint8Array([1]) }, aborted.signal),
      ),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(
      cancelled.every((result) => result.status === "failed" && result.reason === "cancelled"),
    ).toBe(true);
    // Twelve cancelled callers left every queue position free for live work.
    const live = new AbortController();
    const queued = Array.from({ length: 8 }, () =>
      extract({ format: "pdf", bytes: new Uint8Array([1]) }, live.signal),
    );
    await expect(
      extract({ format: "pdf", bytes: new Uint8Array([1]) }, live.signal),
    ).resolves.toMatchObject({ status: "failed", reason: "busy" });
    live.abort();
    blocker.abort();
    await Promise.all([running, ...queued]);
  });

  it("queues a bounded number of extractions and refuses the rest", async () => {
    const controller = new AbortController();
    const extract = makeDocumentTextExtractor({
      maxConcurrent: 1,
      resolveCommand: () => scriptWorker("setInterval(() => {}, 1000);"),
    });
    const pending = Array.from({ length: 9 }, () =>
      extract({ format: "pdf", bytes: new Uint8Array([1]) }, controller.signal),
    );
    await expect(
      extract({ format: "pdf", bytes: new Uint8Array([1]) }, controller.signal),
    ).resolves.toMatchObject({ status: "failed", reason: "busy" });
    controller.abort();
    const settled = await Promise.all(pending);
    expect(
      settled.every((result) => result.status === "failed" && result.reason === "cancelled"),
    ).toBe(true);
  });
});
