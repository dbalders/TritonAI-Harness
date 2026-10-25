import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { parse } from "yaml";

// Each job runs on a fresh runner. Installing a browser in another job cannot
// satisfy this job, and web/server can require different Playwright revisions.
const browserJobs = [
  ["ci", "test", "playwright", "apps/web"],
  ["ci", "test_server", "playwright-core", "apps/server"],
  ["nightly", "test", "playwright", "apps/web"],
  ["nightly", "test_server", "playwright-core", "apps/server"],
  ["release", "preflight", "playwright", "apps/web"],
  ["release", "preflight", "playwright-core", "apps/server"],
] as const;

it.layer(NodeServices.layer)("browser test workflow prerequisites", (it) => {
  // regression: #441 fix(ci): provision Chromium for nightly web tests
  it.effect.each(
    browserJobs.map(([workflowName, jobName, dependency, workspace]) => ({
      workflowName,
      jobName,
      dependency,
      workspace,
    })),
  )(
    "$workflowName.$jobName installs $dependency Chromium from $workspace before testing",
    ({ workflowName, jobName, dependency, workspace }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workflowPath = yield* path.fromFileUrl(
          new URL(`../.github/workflows/${workflowName}.yml`, import.meta.url),
        );
        const workflow = parse(yield* fs.readFileString(workflowPath));
        const steps: { name?: string; run?: string; uses?: string; if?: string }[] =
          workflow.jobs[jobName].steps;
        const installCommand = `node ${workspace}/node_modules/${dependency}/cli.js install --with-deps --only-shell chromium`;
        const browserSetup = steps.findIndex((step) =>
          step.run?.split("\n").some((line) => line.trim() === installCommand),
        );
        const dependencySetup = steps.findIndex((step) =>
          step.uses?.startsWith("voidzero-dev/setup-vp@"),
        );
        const test = steps.findIndex((step) => step.name === "Test");

        assert.isAtLeast(dependencySetup, 0, "workspace dependencies must be installed");
        assert.isAbove(browserSetup, dependencySetup, "install the workspace's locked browser");
        assert.isAbove(test, browserSetup, "install Chromium before starting the test suite");
        assert.isUndefined(steps[browserSetup]?.if, "a cold runner always needs Chromium");
      }),
  );

  // regression: #442 fix(ci): budget nightly browser setup and tests consistently
  it.effect.each(["test", "test_server"] as const)(
    "Nightly %s has at least the regular CI browser setup and test budget",
    (jobName) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ciPath = yield* path.fromFileUrl(
          new URL("../.github/workflows/ci.yml", import.meta.url),
        );
        const nightlyPath = yield* path.fromFileUrl(
          new URL("../.github/workflows/nightly.yml", import.meta.url),
        );
        const ci = parse(yield* fs.readFileString(ciPath));
        const nightly = parse(yield* fs.readFileString(nightlyPath));
        assert.isAtLeast(
          nightly.jobs[jobName]["timeout-minutes"],
          ci.jobs[jobName]["timeout-minutes"],
          "Nightly must budget for browser installation and the full test suite",
        );
      }),
  );
});
