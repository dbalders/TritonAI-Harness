const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { selectConfiguration } = require("./select-stable-plugin-configuration.cjs");

const stable = { packages: [{ id: "microsoft-365" }, { id: "github" }] };
const shared = {
  tableau: { clientId: "nightly-tableau-only" },
  "microsoft-365": { clientId: "stable-m365" },
  "jira-data-center": { clientId: "nightly-jira-only" },
  github: { clientId: "stable-github", nested: { value: "retained" } },
};

test("stable excludes nightly-only configuration and serializes consistently for receipts", () => {
  const actual = selectConfiguration(stable, JSON.stringify(shared));
  assert.deepEqual(JSON.parse(actual), {
    github: shared.github,
    "microsoft-365": shared["microsoft-365"],
  });
  assert.equal(
    actual,
    selectConfiguration(
      { packages: [...stable.packages].reverse() },
      JSON.stringify(shared, null, 2),
    ),
  );
  assert.equal(actual.includes("nightly-"), false);
});

test("selected plugins still require object configuration without revealing values", () => {
  for (const input of [
    undefined,
    "credential-marker",
    "[]",
    "null",
    "{}",
    JSON.stringify({ github: {}, "microsoft-365": null }),
    JSON.stringify({ github: {}, "microsoft-365": [] }),
    " ".repeat(16385),
  ]) {
    assert.throws(
      () => selectConfiguration(stable, input),
      (error) => !error.message.includes("credential-marker"),
    );
  }
  for (const packages of [[], [{ id: "github" }, { id: "github" }], [{ id: "__proto__" }]]) {
    assert.throws(() => selectConfiguration({ packages }, JSON.stringify(shared)));
  }
});

test("CLI masks transformed credentials before export and prevents newline injection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stable-plugin-config-"));
  try {
    fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(stable));
    const config = { ...shared, github: { value: "secret-marker%0A\nINJECTED=value" } };
    const environment = path.join(root, "environment");
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "select-stable-plugin-configuration.cjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TRITONAI_PLUGIN_COMPOSITION_SOURCE: root,
          GITHUB_ENV: environment,
          SHARED_PLUGIN_CONFIGURATION_JSON: JSON.stringify(config),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const selected = selectConfiguration(stable, JSON.stringify(config));
    assert.equal(result.stdout, `::add-mask::${selected.replaceAll("%", "%25")}\n`);
    assert.equal(result.stderr, "");
    const lines = fs.readFileSync(environment, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("TRITONAI_PLUGIN_CONFIGURATION_JSON="));
    assert.equal(
      JSON.parse(lines[0].slice(lines[0].indexOf("=") + 1)).github.value,
      config.github.value,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
