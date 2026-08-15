// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveCuaDriverBinaryPath } from "./DesktopComputerUse.ts";

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
