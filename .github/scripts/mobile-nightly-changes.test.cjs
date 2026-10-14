const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  decideMobileBuild,
  lastSuccessfulMobileSource,
  mobileWorkspaceClosure,
  resolveMobileBuild,
} = require("./mobile-nightly-changes.cjs");

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-changes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  const manifest = (directory, name, dependencies = {}) =>
    write(`${directory}/package.json`, JSON.stringify({ name, dependencies }));
  const commit = (message) => {
    git("add", ".");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  write("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n\ncatalog:\n  react: 19.0.0\n");
  write("package.json", "{}\n");
  manifest("apps/mobile", "@t3tools/mobile", {
    "@t3tools/client-runtime": "workspace:*",
    react: "catalog:",
  });
  manifest("apps/desktop", "@t3tools/desktop", { "@t3tools/shared": "workspace:*" });
  manifest("apps/web", "@t3tools/web");
  manifest("packages/client-runtime", "@t3tools/client-runtime", {
    "@t3tools/contracts": "workspace:*",
  });
  manifest("packages/contracts", "@t3tools/contracts");
  manifest("packages/shared", "@t3tools/shared");
  write("apps/mobile/src/app.tsx", "export {};\n");
  write("apps/desktop/src/main.ts", "export {};\n");
  write("packages/contracts/src/index.ts", "export {};\n");
  const base = commit("base");
  return { root, write, commit, baseline: { tag: "v0.3.8-nightly.20261013.75", sourceSha: base } };
}

test("follows workspace dependencies transitively from the mobile app", (t) => {
  const { root } = repository(t);
  assert.deepEqual(mobileWorkspaceClosure(root), [
    "apps/mobile",
    "packages/client-runtime",
    "packages/contracts",
  ]);
});

test("skips desktop-only, test, and documentation changes", (t) => {
  const { root, write, commit, baseline } = repository(t);
  write("apps/desktop/src/main.ts", "export const changed = true;\n");
  write("packages/shared/src/index.ts", "export {};\n");
  write("packages/contracts/src/index.test.ts", "export {};\n");
  write("apps/mobile/README.md", "# Mobile\n");
  const decision = decideMobileBuild({ root, sourceSha: commit("desktop"), baseline });
  assert.equal(decision.build, false);
  assert.deepEqual(decision.changed, []);
});

test("builds when the app, its shared packages, or build inputs change", (t) => {
  for (const file of [
    "apps/mobile/src/app.tsx",
    "packages/contracts/src/index.ts",
    "pnpm-lock.yaml",
    "assets/nightly/icon.png",
    ".github/scripts/xcode-cloud/ci_post_clone.sh",
  ]) {
    const { root, write, commit, baseline } = repository(t);
    write(file, "changed\n");
    const decision = decideMobileBuild({ root, sourceSha: commit(file), baseline });
    assert.equal(decision.build, true, file);
    assert.deepEqual(decision.changed, [file]);
  }
});

test("skips a source that already built and builds without a usable baseline", (t) => {
  const { root, baseline } = repository(t);
  assert.equal(decideMobileBuild({ root, sourceSha: baseline.sourceSha, baseline }).build, false);
  assert.equal(decideMobileBuild({ root, sourceSha: baseline.sourceSha, baseline: null }).build, true);
  const unknown = { ...baseline, sourceSha: "f".repeat(40) };
  assert.match(
    decideMobileBuild({ root, sourceSha: baseline.sourceSha, baseline: unknown }).reason,
    /not in this checkout/,
  );
  assert.equal(
    decideMobileBuild({ root, sourceSha: baseline.sourceSha, baseline, force: true }).build,
    true,
  );
});

function github(commits, { failChecks = false } = {}) {
  const sha = (name) => name.padEnd(40, "0");
  const calls = [];
  return {
    calls,
    context: { repo: { owner: "dbalders", repo: "TritonAI-Harness" } },
    github: {
      rest: {
        repos: {
          async getCommit({ ref }) {
            calls.push(ref);
            const name = ref === "mobile-nightly" ? commits[0]?.name : ref.replace(/0+$/, "");
            const commit = commits.find((entry) => entry.name === name);
            if (!commit) throw Object.assign(new Error("No commit found"), { status: 422 });
            return { data: { sha: sha(commit.name), parents: commit.parents.map((p) => ({ sha: sha(p) })) } };
          },
          async getContent({ path: file, ref }) {
            assert.equal(file, "apps/mobile/ios/ci_scripts/nightly-source.json");
            const commit = commits.find((entry) => sha(entry.name) === ref);
            const receipt = { tag: commit.tag, sourceSha: commit.source };
            return { data: { content: Buffer.from(JSON.stringify(receipt)).toString("base64") } };
          },
        },
        checks: {
          async listForRef({ ref }) {
            if (failChecks) throw Object.assign(new Error("Resource not accessible"), { status: 403 });
            const commit = commits.find((entry) => sha(entry.name) === ref);
            return {
              data: {
                check_runs: (commit.checks ?? []).map(([slug, conclusion]) => ({
                  app: { slug },
                  conclusion,
                })),
              },
            };
          },
        },
      },
    },
  };
}

const source = (letter) => letter.repeat(40);

test("uses the newest native commit that Xcode Cloud archived", async () => {
  const options = github([
    { name: "c3", parents: ["c2", "s3"], checks: [["xcode-cloud", "failure"]] },
    { name: "c2", parents: ["c1", "s2"], checks: [["github-actions", "success"]] },
    {
      name: "c1",
      parents: ["s1"],
      tag: "v0.3.7-nightly.20261011.71",
      source: source("a"),
      checks: [["xcode-cloud", "success"]],
    },
  ]);
  assert.deepEqual(await lastSuccessfulMobileSource(options), {
    nativeSha: "c1".padEnd(40, "0"),
    tag: "v0.3.7-nightly.20261011.71",
    sourceSha: source("a"),
  });
});

test("returns no baseline for a missing branch or no successful archive", async () => {
  assert.equal(await lastSuccessfulMobileSource(github([])), null);
  const options = github([{ name: "c1", parents: ["s1"], checks: [["xcode-cloud", null]] }]);
  assert.equal(await lastSuccessfulMobileSource(options), null);
  assert.deepEqual(options.calls, ["mobile-nightly"]);
});

test("builds and warns when the previous build cannot be checked", async (t) => {
  const { root, baseline } = repository(t);
  const warnings = [];
  let summary = "";
  const core = {
    outputs: {},
    setOutput(name, value) {
      this.outputs[name] = value;
    },
    warning: (message) => warnings.push(message),
    summary: {
      addRaw(text) {
        summary += text;
        return this;
      },
      async write() {},
    },
  };
  const options = github([{ name: "c1", parents: ["s1"] }], { failChecks: true });
  await resolveMobileBuild({ ...options, core, root, sourceSha: baseline.sourceSha, force: false });
  assert.equal(core.outputs.build, "true");
  assert.match(warnings[0], /Resource not accessible/);
  assert.match(summary, /mobile build needed/);
});
