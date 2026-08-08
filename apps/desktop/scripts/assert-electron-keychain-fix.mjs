import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const minimumFixedVersion = [42, 4, 1];
const desktopDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  NodeFS.readFileSync(NodePath.join(desktopDir, "package.json"), "utf8"),
);
const electronVersion = packageJson.dependencies?.electron;
const installedElectronPackagePath = NodePath.join(
  desktopDir,
  "node_modules",
  "electron",
  "package.json",
);
if (!NodeFS.existsSync(installedElectronPackagePath)) {
  throw new Error(`Installed Electron package is missing: ${installedElectronPackagePath}`);
}
const installedElectronVersion = JSON.parse(
  NodeFS.readFileSync(installedElectronPackagePath, "utf8"),
).version;

function parseExactVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) {
    throw new Error(
      `Electron must be pinned to an exact stable version; found ${JSON.stringify(version)}.`,
    );
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

if (compareVersions(parseExactVersion(electronVersion), minimumFixedVersion) < 0) {
  throw new Error(
    `Electron ${electronVersion} predates the macOS safeStorage lazy-initialization fix; ` +
      `use ${minimumFixedVersion.join(".")} or newer to prevent startup Keychain prompts.`,
  );
}
if (installedElectronVersion !== electronVersion) {
  throw new Error(
    `Installed Electron ${installedElectronVersion} does not match the pinned manifest version ${electronVersion}.`,
  );
}
if (compareVersions(parseExactVersion(installedElectronVersion), minimumFixedVersion) < 0) {
  throw new Error(
    `Installed Electron ${installedElectronVersion} predates the macOS safeStorage lazy-initialization fix.`,
  );
}

process.stdout.write(
  `Electron ${installedElectronVersion} is installed from the exact manifest pin and includes the macOS safeStorage startup fix.\n`,
);
