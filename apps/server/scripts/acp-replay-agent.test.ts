// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "vite-plus/test";

const transcript = {
  scenario: "status-publication",
  entries: [
    { type: "expect_outbound", frame: { kind: "request", method: "initialize" } },
    { type: "emit_inbound", frame: { kind: "response", method: "initialize", result: {} } },
  ],
};
const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`;
const scriptPath = NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url));

function replay(root: string, preload: string) {
  const preloadPath = NodePath.join(root, "observe.mjs");
  NodeFS.writeFileSync(preloadPath, preload);
  return NodeChildProcess.spawnSync(
    process.execPath,
    ["--import", NodeURL.pathToFileURL(preloadPath).href, "--experimental-strip-types", scriptPath],
    {
      encoding: "utf8",
      input: request,
      timeout: 5_000,
      env: {
        T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString("base64"),
        T3_ACP_REPLAY_STATUS_PATH: NodePath.join(root, "status.json"),
      },
    },
  );
}

it("publishes consumed progress before an answer can trigger session shutdown", ({
  onTestFinished,
}) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-replay-status-"));
  onTestFinished(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  const observedPath = NodePath.join(root, "observed.json");
  const result = replay(
    root,
    `import fs from 'node:fs';
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => {
  fs.writeFileSync(${JSON.stringify(observedPath)}, fs.readFileSync(process.env.T3_ACP_REPLAY_STATUS_PATH));
  return write(...args);
};`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { jsonrpc: "2.0", id: 1, result: {} });
  assert.deepEqual(JSON.parse(NodeFS.readFileSync(observedPath, "utf8")), {
    scenario: transcript.scenario,
    cursor: transcript.entries.length,
    total: transcript.entries.length,
  });
});
