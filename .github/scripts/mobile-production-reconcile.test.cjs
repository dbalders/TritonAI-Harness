const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Execute the workflow's actual shell with local CLI doubles. No Expo, Apple,
// Play or GitHub request is made, including build/update/submit commands.
const workflow = fs.readFileSync(
  path.resolve(__dirname, "../workflows/mobile-eas-production.yml"),
  "utf8",
);
const block = workflow
  .split("name: Publish OTA or cut store build")[1]
  .split("        run: |\n")[1];
const script = block
  .split("\n")
  .filter((line) => line.startsWith("          ") || !line.trim())
  .map((line) => line.slice(10))
  .join("\n");
const build = (status, appVersion = "0.3.1") => ({ status, appVersion });
function reconcile(t, data) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-reconcile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const commands = path.join(root, "commands");
  const summary = path.join(root, "summary");
  fs.writeFileSync(commands, "");
  fs.writeFileSync(summary, "");
  const payload = path.join(root, "data.json");
  fs.writeFileSync(payload, JSON.stringify(data));
  const cli = path.join(root, "cli.cjs");
  fs.writeFileSync(
    cli,
    `const fs = require('node:fs'); const path = require('node:path');
const name = path.basename(process.argv[2]); const args = process.argv.slice(3);
const data = JSON.parse(fs.readFileSync(process.env.FIXTURE_DATA));
if (name === 'npx') console.log(JSON.stringify({version:'0.3.1'}));
else if (name === 'git') console.log(args[0] === 'log' ? 'fixture commit' : 'abcdef123');
else if (args[0] === 'fingerprint:generate') console.log(JSON.stringify({hash:'fixture-hash'}));
else if (args[0] === 'build:list') {
 const query = args.includes('--app-version') ? 'current'
   : args.includes('--fingerprint-hash') ? 'matches'
   : args.includes('--status') ? 'latestFinished' : 'recent';
 if (data.failQuery === query) process.exit(23);
 console.log(JSON.stringify(data[query] || []));
} else fs.appendFileSync(process.env.FIXTURE_COMMANDS, JSON.stringify(args) + '\\n');
`,
  );
  for (const name of ["eas", "npx", "git"]) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\nexec '${process.execPath}' '${cli}' '${name}' "$@"\n`,
      { mode: 0o755 },
    );
  }
  const result = cp.spawnSync("bash", ["-e", "-c", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_STEP_SUMMARY: summary,
      FIXTURE_DATA: payload,
      FIXTURE_COMMANDS: commands,
    },
  });
  return {
    ...result,
    summary: fs.readFileSync(summary, "utf8"),
    calls: fs.readFileSync(commands, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}
const posix = { skip: os.platform() === "win32" };
for (const status of ["ERRORED", "CANCELED"]) {
  test(
    `reports a ${status} version bump even with an older matching finished build`,
    posix,
    (t) => {
      const old = build("FINISHED", "0.3.0");
      const failed = build(status);
      const result = reconcile(t, {
        matches: [failed, old],
        recent: [failed, old],
        current: [failed],
      });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.calls.filter((args) => args[0] === "build").length, 0);
      assert.equal(result.calls.filter((args) => args[0] === "update").length, 2);
      assert.match(result.summary, new RegExp(`0.3.1.*${status}.*workflow_dispatch`));
    },
  );
}
// regression: d4dd8e9346 fix: address launcher and release workflow review findings
test(
  "a successful older version schedules the new version after only unrelated failures",
  posix,
  (t) => {
    const old = build("FINISHED", "0.3.0");
    const result = reconcile(t, { matches: [old], recent: [build("ERRORED", "0.2.9"), old] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.filter((args) => args[0] === "build").length, 2);
  },
);
// regression: d4dd8e9346 fix: address launcher and release workflow review findings
test(
  "looks beyond a full failed page without duplicating an already finished current version",
  posix,
  (t) => {
    const current = build("FINISHED");
    const result = reconcile(t, {
      matches: [current],
      recent: Array.from({ length: 20 }, () => build("ERRORED", "0.2.9")),
      latestFinished: [current],
      current: [current],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.filter((args) => args[0] === "build").length, 0);
    assert.equal(result.calls.filter((args) => args[0] === "update").length, 2);
  },
);
// regression: d4dd8e9346 fix: address launcher and release workflow review findings
test("an active current-version build prevents duplicate store builds", posix, (t) => {
  const active = build("IN_PROGRESS");
  const result = reconcile(t, { matches: [active], recent: [active], current: [active] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 0);
  assert.match(result.summary, /in progress/);
});

for (const failQuery of ["latestFinished", "current"]) {
  test(`a failed ${failQuery} query stops before any publish or build`, posix, (t) => {
    const result = reconcile(t, { matches: [build("FINISHED", "0.3.0")], failQuery });
    assert.equal(result.status, 23, result.stderr);
    assert.equal(result.calls.length, 0);
  });
}
