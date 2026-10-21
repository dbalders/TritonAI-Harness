import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parse } from "yaml";

it.layer(NodeServices.layer)("release workflow channel", (it) => {
  it.effect("builds stable and nightly plugins entirely from the exact Harness source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const name of ["release", "nightly"]) {
        const workflowPath = yield* path.fromFileUrl(
          new URL(`../.github/workflows/${name}.yml`, import.meta.url),
        );
        const source = yield* fs.readFileString(workflowPath);
        const workflow = parse(source);
        assert.notInclude(source, "TRITONAI_INSTALLER_COMPOSITION_COMMIT");
        assert.notInclude(source, "dbalders/TritonAI-Installer");
        assert.notInclude(source, ".release-input/installer");
        for (const jobName of ["prepare_managed_plugins", "mac"]) {
          const checkout = workflow.jobs[jobName].steps.find((step: { uses?: string }) =>
            step.uses?.startsWith("actions/checkout@"),
          );
          assert.equal(checkout.with.ref, "${{ needs.preflight.outputs.ref }}");
        }
        const compositionCommands = Object.values<{ steps?: { run?: string }[] }>(workflow.jobs)
          .flatMap((job) => job.steps ?? [])
          .flatMap((step) =>
            (step.run ?? "")
              .split("\n")
              .filter((line) => line.includes("prepare-managed-plugins.cjs")),
          )
          .map((line) => line.trim());
        assert.deepEqual(compositionCommands, [
          `node .github/scripts/prepare-managed-plugins.cjs --production${
            name === "nightly" ? " --nightly" : ""
          }`,
        ]);
        assert.include(source, "node .github/scripts/finalize-macos-release.cjs");
        assert.include(source, "path: .release-input/plugins");
      }
    }),
  );

  it.effect("accepts controlled stable dispatches and rejects every nightly version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const workflowPath = yield* path.fromFileUrl(
        new URL("../.github/workflows/release.yml", import.meta.url),
      );
      const workflow = parse(yield* fs.readFileString(workflowPath));
      const script = workflow.jobs.resolve_release.steps.find(
        (step: { id?: string }) => step.id === "release_meta",
      ).run;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "nightly-channel-" });
      for (const [version, channel, prerelease, latest] of [
        ["0.3.4", "stable", "false", "true"],
        ["0.3.4-rc.1", "stable", "true", "false"],
        ["0.3.4-nightly.20260912.1", null, null, null],
        ["0.3.4-nightly.20260912", null, null, null],
      ] as const) {
        const output = path.join(root, version);
        const exitCode = yield* spawner.exitCode(
          ChildProcess.make("bash", ["-e", "-c", script], {
            env: {
              GITHUB_EVENT_NAME: "workflow_dispatch",
              DISPATCH_VERSION: version,
              GITHUB_OUTPUT: output,
            },
          }),
        );
        if (channel === null) {
          assert.notEqual(Number(exitCode), 0);
          assert.equal(yield* fs.exists(output), false);
        } else {
          assert.equal(Number(exitCode), 0);
          const values = Object.fromEntries(
            (yield* fs.readFileString(output))
              .trim()
              .split("\n")
              .map((line) => line.split("=")),
          );
          assert.include(values, {
            release_channel: channel,
            version,
            is_prerelease: prerelease,
            make_latest: latest,
            ref: `v${version}`,
          });
        }
      }
    }),
  );
});
