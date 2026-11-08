const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const test = require("node:test");
const { parse } = createRequire(path.resolve("scripts/package.json"))("yaml");

const workflow = parse(fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8"));
const step = workflow.jobs.check.steps.find((step) => step.name === "Require every job to pass");
const posix = { skip: os.platform() === "win32" };
function results(changed = "true") {
  const needs = Object.fromEntries(
    workflow.jobs.check.needs.map((id) => [id, { result: "success" }]),
  );
  needs.mobile_native_changes.outputs = { changed };
  return needs;
}
function check(needs) {
  return cp.spawnSync("bash", ["-e", "-c", step.run], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH, RESULTS: JSON.stringify(needs) },
  });
}

test("accepts successful required jobs", posix, () => {
  assert.equal(check(results()).status, 0);
});
test("accepts static analysis skipped by a successful clean native gate", posix, () => {
  const needs = results("false");
  needs.mobile_native_static_analysis.result = "skipped";
  assert.equal(check(needs).status, 0);
});
for (const changed of ["true", "", undefined, false]) {
  test(`rejects static analysis skipped with changed=${String(changed)}`, posix, () => {
    const needs = results(changed);
    if (changed === undefined) delete needs.mobile_native_changes.outputs.changed;
    needs.mobile_native_static_analysis.result = "skipped";
    assert.notEqual(check(needs).status, 0);
  });
}
for (const result of ["failure", "cancelled", "skipped"]) {
  test(`rejects a ${result} native gate even with a clean output`, posix, () => {
    const needs = results("false");
    needs.mobile_native_changes.result = result;
    needs.mobile_native_static_analysis.result = "skipped";
    assert.notEqual(check(needs).status, 0);
  });
  test(`rejects another required job that is ${result}`, posix, () => {
    const needs = results();
    needs.test.result = result;
    assert.notEqual(check(needs).status, 0);
  });
}
