import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const minimumFixedVersion = [42, 4, 1];
const desktopDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  NodeFS.readFileSync(NodePath.join(desktopDir, "package.json"), "utf8"),
);
const electronVersion = packageJson.dependencies?.electron;

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

process.stdout.write(`Electron ${electronVersion} includes the macOS safeStorage startup fix.\n`);
