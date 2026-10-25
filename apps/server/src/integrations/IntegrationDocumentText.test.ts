// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - exercises a real child process and its bounded kill timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { makeDocx, makePdf } from "./documentText/DocumentTextFixtures.testkit.ts";
import { documentTextWorkerLimitsInEffect } from "./documentText/documentTextWorker.ts";
import {
  makeDocumentTextExtractor,
  resolveDocumentTextWorkerCommand,
  type DocumentTextWorkerCommand,
} from "./IntegrationDocumentText.ts";

vi.mock("node:child_process", { spy: true });

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
describe("isolated document text extraction", () => {
  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("runs the extractor with effective heap and code-generation limits and none of the server's environment", async () => {
    process.env.TRITONAI_DOCUMENT_TEXT_TEST_SECRET = "must-not-leak";
    try {
      const extract = makeDocumentTextExtractor({
        heapMb: 96,
        resolveCommand: () =>
          scriptWorker(
            `let codegen = "allowed"; try { new Function("return 1"); } catch (error) { codegen = error.name; }
             const report = { env: process.env, execArgv: process.execArgv, codegen,
               heapMiB: require("node:v8").getHeapStatistics().heap_size_limit / 1048576 };
             process.stdout.write(JSON.stringify({status:"extracted",format:"pdf",truncated:false,text:JSON.stringify(report)}))`,
          ),
      });
      const result = await extract({ format: "pdf", bytes: new Uint8Array([1]) }, signal());
      expect(result.status).toBe("extracted");
      const report = JSON.parse(result.status === "extracted" ? result.text : "{}");
      expect(report.env.TRITONAI_DOCUMENT_TEXT_TEST_SECRET).toBeUndefined();
      expect(report.env.NODE_OPTIONS).toBeUndefined();
      expect(report.execArgv.slice(0, 2)).toEqual([
        "--max-old-space-size=96",
        "--disallow-code-generation-from-strings",
      ]);
      expect(report.codegen).toBe("EvalError");
      expect(report.heapMiB).toBeLessThan(96 + 512);
    } finally {
      delete process.env.TRITONAI_DOCUMENT_TEXT_TEST_SECRET;
    }
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("refuses to parse when the worker's limits are not in effect", async () => {
    expect(documentTextWorkerLimitsInEffect(96)).toBe(false);
    const run = (runtimeArgs: ReadonlyArray<string>, heapMb: string) =>
      NodeChildProcess.spawnSync(
        process.execPath,
        [...runtimeArgs, serverEntry, "__document-text", "docx", "100", heapMb],
        { input: makeDocx(["Synthetic canary 9X2-DOCX"]), encoding: "utf8", env: {} },
      ).stdout;
    expect(JSON.parse(run([], "96"))).toMatchObject({ status: "failed", reason: "unavailable" });
    expect(JSON.parse(run(["--max-old-space-size=96"], "96"))).toMatchObject({
      status: "failed",
      reason: "unavailable",
    });
    expect(JSON.parse(run(["--disallow-code-generation-from-strings"], "96"))).toMatchObject({
      status: "failed",
      reason: "unavailable",
    });
    expect(
      JSON.parse(run(["--max-old-space-size=96", "--disallow-code-generation-from-strings"], "x")),
    ).toMatchObject({ status: "failed", reason: "unavailable" });
    expect(
      JSON.parse(run(["--max-old-space-size=96", "--disallow-code-generation-from-strings"], "96")),
    ).toMatchObject({ status: "extracted", text: "Synthetic canary 9X2-DOCX" });
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("passes the limits through NODE_OPTIONS only for a single-executable worker", async () => {
    const extract = makeDocumentTextExtractor({
      heapMb: 96,
      resolveCommand: () => ({
        ...scriptWorker(
          `process.stdout.write(JSON.stringify({status:"extracted",format:"pdf",truncated:false,text:JSON.stringify({options:process.env.NODE_OPTIONS,execArgv:process.execArgv})}))`,
        ),
        limitsVia: "environment",
      }),
    });
    const result = await extract({ format: "pdf", bytes: new Uint8Array([1]) }, signal());
    const report = JSON.parse(result.status === "extracted" ? result.text : "{}");
    expect(report.options).toBe("--max-old-space-size=96 --disallow-code-generation-from-strings");
    expect(report.execArgv[0]).toBe("-e");
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("reports a worker that exhausts its memory allowance", async () => {
    const extract = makeDocumentTextExtractor({
      heapMb: 32,
      resolveCommand: () =>
        scriptWorker("const keep = []; for (;;) keep.push(new Array(1e5).fill({ a: 1 }));"),
    });
    await expect(
      extract({ format: "pdf", bytes: new Uint8Array([1]) }, signal()),
    ).resolves.toMatchObject({ status: "failed", reason: "resource_limit" });
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("stops the worker when the invocation is cancelled", async () => {
    using spawn = vi.spyOn(NodeChildProcess, "spawn").mockClear();
    const controller = new AbortController();
    const extract = makeDocumentTextExtractor({
      resolveCommand: () =>
        scriptWorker('process.stdout.write("ready"); setInterval(() => {}, 1000);'),
    });
    const pending = extract({ format: "pdf", bytes: new Uint8Array([1]) }, controller.signal);
    const child = spawn.mock.results[0]?.value;
    if (!child?.stdout) throw new Error("Worker stdout was not available.");
    const closed = NodeEvents.EventEmitter.once(child, "close");
    await NodeEvents.EventEmitter.once(child.stdout, "data");
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "failed", reason: "cancelled" });
    await expect(closed).resolves.toEqual([null, "SIGKILL"]);
  });

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
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

  // regression: #417 fix(server): bound attachment text extraction and browser navigation approval
  it("returns an already-cancelled request at once without taking a queue slot", async () => {
    const blocker = new AbortController();
    const extract = makeDocumentTextExtractor({
      maxConcurrent: 1,
      resolveCommand: () => scriptWorker("setInterval(() => {}, 1000);"),
    });
    const running = extract({ format: "pdf", bytes: new Uint8Array([1]) }, blocker.signal);
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await Promise.all(
      Array.from({ length: 12 }, () =>
        extract({ format: "pdf", bytes: new Uint8Array([1]) }, aborted.signal),
      ),
    );
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
});
