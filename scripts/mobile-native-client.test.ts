import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { NativeClientError, prebuildAndroid } from "./mobile-native-client.ts";

const caches = [".gradle/history", "app/.cxx/object"];

// A generated Android project with Gradle and native outputs, and a stand-in for
// `expo prebuild --clean`, which deletes the directory and writes fresh sources.
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mobile = yield* fs.makeTempDirectoryScoped({ prefix: "mobile-native-client-" });
  const android = path.join(mobile, "android");
  for (const cache of caches) {
    yield* fs.makeDirectory(path.dirname(path.join(android, cache)), { recursive: true });
    yield* fs.writeFileString(path.join(android, cache), cache);
  }
  const cleanPrebuild = Effect.gen(function* () {
    yield* fs.remove(android, { recursive: true });
    yield* fs.makeDirectory(path.join(android, "app"), { recursive: true });
    yield* fs.writeFileString(path.join(android, "app/build.gradle"), "regenerated");
  });
  const assertCachesRestored = Effect.gen(function* () {
    for (const cache of caches) {
      assert.strictEqual(yield* fs.readFileString(path.join(android, cache)), cache);
    }
    assert.deepStrictEqual(yield* fs.readDirectory(mobile), ["android"]);
  });
  return { fs, path, mobile, android, cleanPrebuild, assertCachesRestored };
});

it.layer(NodeServices.layer)("prebuildAndroid", (it) => {
  it.effect("keeps Gradle and native caches through a clean prebuild", () =>
    Effect.gen(function* () {
      const { fs, path, mobile, android, cleanPrebuild, assertCachesRestored } = yield* fixture;

      yield* prebuildAndroid(mobile, cleanPrebuild);

      assert.strictEqual(
        yield* fs.readFileString(path.join(android, "app/build.gradle")),
        "regenerated",
      );
      yield* assertCachesRestored;
    }),
  );

  it.effect("restores the caches and returns the error when prebuild fails", () =>
    Effect.gen(function* () {
      const { mobile, cleanPrebuild, assertCachesRestored } = yield* fixture;
      const failure = new NativeClientError({ message: "prebuild failed" });

      const error = yield* prebuildAndroid(
        mobile,
        cleanPrebuild.pipe(Effect.andThen(Effect.fail(failure))),
      ).pipe(Effect.flip);

      assert.strictEqual(error, failure);
      yield* assertCachesRestored;
    }),
  );
});

import { describe, expect } from "vite-plus/test";
import { iosBuildTarget, nativeClientAppId } from "./mobile-native-client.ts";

describe("generated iOS build identity", () => {
  it("uses the downstream workspace, scheme and application after Expo prebuild", () => {
    expect(
      iosBuildTarget([
        "Pods",
        "Podfile",
        "TritonAIHarnessDev.xcworkspace",
        "TritonAIHarnessDev.xcodeproj",
      ]),
    ).toEqual({
      workspace: "TritonAIHarnessDev.xcworkspace",
      scheme: "TritonAIHarnessDev",
      appFile: "TritonAIHarnessDev.app",
    });
  });
  it("continues to support upstream development identities", () => {
    expect(iosBuildTarget(["T3CodeDev.xcworkspace"]).scheme).toBe("T3CodeDev");
  });
  it("refuses missing or ambiguous workspaces before invoking Xcode", () => {
    expect(() => iosBuildTarget(["Podfile"])).toThrow("Expected one generated iOS workspace");
    expect(() => iosBuildTarget(["One.xcworkspace", "Two.xcworkspace"])).toThrow(
      "Expected one generated iOS workspace",
    );
  });
});

it("detects the installed development app by its platform-specific identity", () => {
  expect(nativeClientAppId("ios")).toBe("edu.ucsd.tritonai.harness.dev");
  expect(nativeClientAppId("android")).toBe("com.t3tools.t3code.dev");
});
