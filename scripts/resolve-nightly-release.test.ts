import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";

import {
  readDesktopBaseVersion,
  prepareNightlyRelease,
  resolveNightlyBaseVersion,
  resolveNightlyReleaseMetadata,
  resolveNightlyTargetVersion,
  writeNightlyReleaseOutput,
} from "./resolve-nightly-release.ts";

const encodeFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFixture = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

it("strips prerelease and build metadata when deriving the nightly base version", () => {
  assert.equal(resolveNightlyBaseVersion("0.0.17"), "0.0.17");
  assert.equal(resolveNightlyBaseVersion("9.9.9-smoke.0"), "9.9.9");
  assert.equal(resolveNightlyBaseVersion("1.2.3-beta.4+build.9"), "1.2.3");
});

it.effect("bumps the patch version before deriving nightly prerelease versions", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveNightlyTargetVersion("0.0.17"), "0.0.18");
    assert.equal(yield* resolveNightlyTargetVersion("9.9.9-smoke.0"), "9.9.10");
    assert.equal(yield* resolveNightlyTargetVersion("1.2.3-beta.4+build.9"), "1.2.4");
  }),
);

it.effect("reports the invalid desktop package version", () =>
  Effect.gen(function* () {
    const error = yield* resolveNightlyTargetVersion("nightly").pipe(Effect.flip);

    assert.equal(error._tag, "InvalidDesktopPackageVersionError");
    assert.equal(error.version, "nightly");
    assert.equal(error.message, "Invalid desktop package version 'nightly'.");
  }),
);

it("derives nightly metadata including the short commit sha in the release name", () => {
  assert.deepStrictEqual(
    resolveNightlyReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-nightly.20260413.321",
      tag: "v9.9.10-nightly.20260413.321",
      name: "TritonAI Harness Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});

it.effect("preserves the GITHUB_OUTPUT configuration cause", () => {
  const metadata = resolveNightlyReleaseMetadata("1.2.4", "20260620", 42, "abcdef1234567890");
  const configCause = new ConfigProvider.SourceError({ message: "environment unavailable" });

  return Effect.gen(function* () {
    const configError = yield* writeNightlyReleaseOutput(metadata, true).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.make(() => Effect.fail(configCause)),
      ),
      Effect.flip,
    );

    if (configError._tag !== "NightlyReleaseGitHubOutputConfigError") {
      return assert.fail(`Unexpected error: ${configError._tag}`);
    }
    assert.instanceOf(configError.cause, Config.ConfigError);
    assert.strictEqual(configError.cause.cause, configCause);
    assert.notInclude(configError.message, configCause.message);
  });
});

it.layer(NodeServices.layer)("readDesktopBaseVersion", (it) => {
  it.effect("preserves desktop package read context and its platform cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-read-",
      });
      const packageJsonPath = path.join(rootDir, "apps/desktop/package.json");

      const error = yield* readDesktopBaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "NightlyReleaseDesktopPackageError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "read");
      assert.equal(error.packageJsonPath, packageJsonPath);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );

  it.effect("preserves desktop package decode context and its schema cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "resolve-nightly-release-decode-",
      });
      const packageJsonPath = path.join(rootDir, "apps/desktop/package.json");
      yield* fs.makeDirectory(path.dirname(packageJsonPath), { recursive: true });
      yield* fs.writeFileString(packageJsonPath, "{");

      const error = yield* readDesktopBaseVersion(rootDir).pipe(Effect.flip);

      if (error._tag !== "NightlyReleaseDesktopPackageError") {
        return assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "decode");
      assert.equal(error.packageJsonPath, packageJsonPath);
      assert.ok(error.cause !== undefined);
      assert.notInclude(error.message, String((error.cause as Error).message));
    }),
  );
});

it.layer(NodeServices.layer)("prepareNightlyRelease", (it) => {
  it.effect(
    "stamps desktop, server, web, and contracts consistently without touching the stable source",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "nightly-prepare-" });
        const files = [
          "apps/desktop/package.json",
          "apps/server/package.json",
          "apps/web/package.json",
          "packages/contracts/package.json",
        ];
        for (const file of files) {
          yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
          yield* fs.writeFileString(
            path.join(root, file),
            yield* encodeFixture({
              name: file,
              version: "0.3.3",
              private: true,
            }),
          );
        }
        const metadata = resolveNightlyReleaseMetadata(
          yield* readDesktopBaseVersion(root),
          "20260912",
          1,
          "abcdef123456",
        );
        yield* prepareNightlyRelease(metadata, root);
        for (const file of files) {
          const manifest = yield* decodeFixture(yield* fs.readFileString(path.join(root, file)));
          assert.deepEqual(manifest, {
            name: file,
            version: "0.3.4-nightly.20260912.1",
            private: true,
          });
        }
        assert.equal(metadata.tag, "v0.3.4-nightly.20260912.1");
      }),
  );
});
