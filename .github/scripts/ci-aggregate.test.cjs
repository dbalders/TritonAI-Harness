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
  needs.desktop_packaging_scope.outputs = { changed: "true" };
  return needs;
}
function check(needs) {
  return cp.spawnSync("bash", ["-e", "-c", step.run], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH, RESULTS: JSON.stringify(needs) },
  });
}
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

test(
  "requires native packaging unless a successful scope job explicitly excludes it",
  posix,
  () => {
    for (const id of ["packaging_wsl", "desktop_packaging"]) {
      for (const result of ["failure", "cancelled", "skipped"]) {
        const needs = results();
        needs[id].result = result;
        assert.notEqual(check(needs).status, 0, `${id}: ${result}`);
      }
    }
    const needs = results();
    needs.packaging_wsl.result = "skipped";
    needs.desktop_packaging.result = "skipped";
    for (const changed of ["true", "", undefined]) {
      needs.desktop_packaging_scope.outputs.changed = changed;
      assert.notEqual(check(needs).status, 0);
    }
    needs.desktop_packaging_scope.outputs.changed = "false";
    assert.equal(check(needs).status, 0);
    for (const result of ["failure", "cancelled", "skipped"]) {
      needs.desktop_packaging_scope.result = result;
      assert.notEqual(check(needs).status, 0);
    }
  },
);
