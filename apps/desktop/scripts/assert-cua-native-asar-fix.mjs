import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopRoot = NodePath.resolve(scriptDirectory, "..");
const cuaDriverRoot = NodeFS.realpathSync(
  NodePath.join(desktopRoot, "node_modules", "@trycua", "cua-driver"),
);
const cuaDriverRequire = NodeModule.createRequire(NodePath.join(cuaDriverRoot, "package.json"));
const resolverPath = cuaDriverRequire.resolve("@ubjs/node/typescript/dist/resolve-lib.js");
const { resolveLibPath, setDetectTripleForTesting } = cuaDriverRequire(resolverPath);

const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tritonai-cua-asar-path-"));
const archiveRoot = NodePath.join(temporaryRoot, "app.asar");
const unpackedRoot = `${archiveRoot}.unpacked`;
const packageName = "tritonai-cua-native-test-triple";
const packageRelativePath = NodePath.join("node_modules", packageName);
const libraryNames = ["cua_driver_sdk.dll", "libcua_driver_sdk.dylib", "libcua_driver_sdk.so"];
const previousTripleDetector = setDetectTripleForTesting(() => "test-triple");

try {
  for (const root of [archiveRoot, unpackedRoot]) {
    const packageRoot = NodePath.join(root, packageRelativePath);
    NodeFS.mkdirSync(packageRoot, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: packageName, version: "0.0.0" })}\n`,
    );
    for (const libraryName of libraryNames) {
      NodeFS.writeFileSync(NodePath.join(packageRoot, libraryName), "native-library-fixture");
    }
  }
  const callerPath = NodePath.join(archiveRoot, "apps", "desktop", "dist-electron", "main.cjs");
  NodeFS.mkdirSync(NodePath.join(archiveRoot, "apps", "desktop", "dist-electron"), {
    recursive: true,
  });
  NodeFS.writeFileSync(callerPath, "");

  const resolvedPath = resolveLibPath({
    crateName: "cua_driver_sdk",
    callerUrl: NodeURL.pathToFileURL(callerPath).href,
    npmPackageBase: "tritonai-cua-native-",
    tripleStyle: "node",
  });

  NodeAssert.equal(
    NodePath.dirname(NodeFS.realpathSync(resolvedPath)),
    NodeFS.realpathSync(NodePath.join(unpackedRoot, packageRelativePath)),
  );
} finally {
  setDetectTripleForTesting(previousTripleDetector);
  NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
}
