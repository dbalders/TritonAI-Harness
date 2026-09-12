import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { parse } from "yaml";

it.layer(NodeServices.layer)("release workflow channel", (it) => {
  it.effect("classifies stable and nightly dispatches and rejects malformed nightly versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const workflowPath = yield* path.fromFileUrl(
        new URL("../.github/workflows/release.yml", import.meta.url),
      );
      const workflow = parse(yield* fs.readFileString(workflowPath));
      const script = workflow.jobs.preflight.steps.find(
        (step: { id?: string }) => step.id === "release_meta",
      ).run;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "nightly-channel-" });
      for (const [version, channel, prerelease, latest] of [
        ["0.3.4", "stable", "false", "true"],
        ["0.3.4-nightly.20260912.1", "nightly", "true", "false"],
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
