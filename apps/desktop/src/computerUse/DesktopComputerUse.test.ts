// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { EmbeddedCuaDriverHost } from "@trycua/cua-driver/embedded";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  CUA_DRIVER_POLICY,
  CuaDriverPolicy,
  createCuaDriverHostOptions,
  prepareCuaDriverHome,
  resolveCuaDriverBinaryPath,
} from "./DesktopComputerUse.ts";

const environment = (
  platform: NodeJS.Platform,
  isPackaged = false,
): DesktopEnvironment.DesktopEnvironment["Service"] =>
  ({
    platform,
    isPackaged,
    resourcesPath: "/opt/TritonAI Harness/resources",
    path: NodePath.posix,
  }) as unknown as DesktopEnvironment.DesktopEnvironment["Service"];

it("resolves the bundled Cua Driver outside ASAR", () => {
  NodeAssert.equal(
    resolveCuaDriverBinaryPath(environment("darwin"), undefined),
    "/opt/TritonAI Harness/resources/cua-driver/cua-driver",
  );
  NodeAssert.equal(
    resolveCuaDriverBinaryPath(environment("win32"), undefined),
    "/opt/TritonAI Harness/resources/cua-driver/cua-driver.exe",
  );
});

it("allows an explicit development Cua Driver binary", () => {
  NodeAssert.equal(
    resolveCuaDriverBinaryPath(environment("darwin"), "/tmp/tools/cua-driver"),
    "/tmp/tools/cua-driver",
  );
});

it("does not allow the development override to bypass the packaged driver", () => {
  NodeAssert.equal(
    resolveCuaDriverBinaryPath(environment("darwin", true), "/tmp/unreviewed-cua-driver"),
    "/opt/TritonAI Harness/resources/cua-driver/cua-driver",
  );
});

it.effect("constructs an embedded host with isolated telemetry and update policy", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "tritonai-cua-driver-test-",
    });
    const driverHomeDirectory = NodePath.join(temporaryDirectory, "driver-home");
    const configPath = yield* prepareCuaDriverHome({
      fileSystem,
      path: NodePath,
      driverHomeDirectory,
    });

    const decodePolicy = Schema.decodeUnknownEffect(Schema.fromJsonString(CuaDriverPolicy));
    NodeAssert.deepEqual(yield* decodePolicy(yield* fileSystem.readFileString(configPath)), {
      telemetry_enabled: false,
      update_check_enabled: false,
    });
    NodeAssert.deepEqual(CUA_DRIVER_POLICY, {
      telemetry_enabled: false,
      update_check_enabled: false,
    });

    const options = createCuaDriverHostOptions({
      binaryPath: "/tmp/cua-driver",
      driverHomeDirectory,
      hostBundleId: "edu.ucsd.tritonai.harness.test",
      inheritStderr: false,
    });
    NodeAssert.deepEqual(options.environment, [{ name: "HOME", value: driverHomeDirectory }]);

    const host = EmbeddedCuaDriverHost.withOptions(options) as ReturnType<
      typeof EmbeddedCuaDriverHost.withOptions
    > & {
      readonly uniffiDestroy?: () => void;
    };
    host.uniffiDestroy?.();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
