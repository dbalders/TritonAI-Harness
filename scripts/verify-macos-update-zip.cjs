const NodeFSP = require("node:fs/promises");
const NodeOS = require("node:os");
const extractZip = require("extract-zip");
const NodeFS = require("node:fs");
const NodePath = require("node:path");

// ShipIt may install as root. The build user's ability to launch the app does
// not prove that the installed bundle will be accessible to its actual users.
function assertMacosBundlePermissions(appPath) {
  if (!NodeFS.lstatSync(appPath).isDirectory()) {
    throw new Error(`Expected an app bundle directory: ${appPath}`);
  }
  const pending = [appPath];
  while (pending.length > 0) {
    const entry = pending.pop();
    const info = NodeFS.lstatSync(entry);
    // Framework links point into directories checked by the same traversal.
    if (info.isSymbolicLink()) continue;
    const executable = info.isDirectory() || (info.mode & 0o111) !== 0;
    const required = executable ? 0o005 : 0o004;
    if ((info.mode & required) !== required) {
      const mode = (info.mode & 0o777).toString(8);
      throw new Error(
        `macOS app is inaccessible after an administrator update: ${NodePath.relative(appPath, entry) || NodePath.basename(appPath)} has mode ${mode}; all users need ${executable ? "read and execute" : "read"} access.`,
      );
    }
    if (info.isDirectory()) {
      for (const child of NodeFS.readdirSync(entry)) pending.push(NodePath.join(entry, child));
    }
  }
}

async function verifyMacosUpdateZip(archive) {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "verify-macos-update-"));
  try {
    await extractZip(NodePath.resolve(archive), { dir: scratch });
    const apps = (await NodeFSP.readdir(scratch)).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("Updater ZIP must contain exactly one app bundle.");
    assertMacosBundlePermissions(NodePath.join(scratch, apps[0]));
    console.log("Updater ZIP permissions allow launch after an administrator installation.");
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

module.exports = { assertMacosBundlePermissions, verifyMacosUpdateZip };
if (require.main === module) {
  const [archive] = process.argv.slice(2);
  if (!archive || process.argv.length !== 3)
    throw new Error("Usage: verify-macos-update-zip.cjs UPDATE.zip");
  verifyMacosUpdateZip(archive).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
