#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import {
  assertPackagedDesktopUpdateConfig,
  assertPackagedFfiRsNativeBinaries,
} from "./build-desktop-artifact.ts";

// The local release finalizer owns signing. Run the same packaged-payload gates
// as the ordinary artifact builder against its final signed app.
const [stageDistDir, productName] = process.argv.slice(2);
if (!stageDistDir || !productName || process.argv.length !== 4) {
  throw new Error("Usage: verify-macos-desktop-package.ts DIST_DIR PRODUCT_NAME");
}
const options = { stageDistDir, productName, platform: "mac" as const, arch: "arm64" as const };
Effect.gen(function* () {
  yield* assertPackagedDesktopUpdateConfig(options);
  yield* assertPackagedFfiRsNativeBinaries(options);
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
