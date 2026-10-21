"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function runActions(file) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict');
    const { measure, measureSync } = require(process.argv[1]);
    const original = new Error('private-action-detail');
    (async () => {
      assert.equal(measureSync('sync success', () => 42), 42);
      assert.throws(() => measureSync('sync failure', () => { throw original; }), e => e === original);
      assert.equal(await measure('async success', async () => 43), 43);
      await assert.rejects(measure('async failure', async () => { throw original; }), e => e === original);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
      path.join(__dirname, "release-timing.cjs"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TRITONAI_RELEASE_TIMING_FILE: file,
        TRITONAI_RELEASE_TIMING_STAGE: "mac",
      },
    },
  );
}

test("timing records successful and failed actions without recording private error details", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-timing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "timings.jsonl");
  const result = runActions(file);
  assert.equal(result.status, 0, result.stderr);
  const data = fs.readFileSync(file, "utf8");
  const records = data.trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    records.map((record) => record.status),
    ["complete", "failed", "complete", "failed"],
  );
  for (const record of records) {
    assert.equal(record.stage, "mac");
    assert(record.durationMs >= 0);
    assert(Date.parse(record.completedAt) >= Date.parse(record.startedAt));
  }
  assert(!`${data}${result.stdout}${result.stderr}`.includes("private-action-detail"));
});

for (const failure of ["mkdir", "append"]) {
  test(`${failure} failure preserves sync/async results and original errors`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-timing-failure-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const blocker = path.join(root, "private-path");
    if (failure === "mkdir") fs.writeFileSync(blocker, "not a directory");
    else fs.mkdirSync(blocker);
    const result = runActions(failure === "mkdir" ? path.join(blocker, "timings.jsonl") : blocker);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.match(/Could not record release timing/g)?.length, 4);
    assert(!result.stderr.includes("private-path"));
    assert(!result.stderr.includes("private-action-detail"));
  });
}
