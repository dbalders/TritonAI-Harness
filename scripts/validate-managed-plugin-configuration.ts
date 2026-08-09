// @effect-diagnostics nodeBuiltinImport:off - This isolated CLI validates untrusted plugin code before the Effect build runtime continues.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  createManagedPluginValidationReceipt,
  loadManagedPluginCompositionFromEnvironment,
  PRODUCTION_PLUGIN_CONFIGURATION_ENV,
  readManagedPluginBuildConfiguration,
  readManagedPluginComposition,
} from "./lib/managed-plugin-composition.ts";
import { validateManagedPluginBuildConfiguration } from "./build-desktop-artifact.ts";

const input = loadManagedPluginCompositionFromEnvironment();
if (!input) {
  throw new Error("Managed plugin configuration validation requires a composition source.");
}

const serializedConfiguration = process.env[PRODUCTION_PLUGIN_CONFIGURATION_ENV]?.trim() ?? "";
const configuration = readManagedPluginBuildConfiguration(input.composition, process.env);
await validateManagedPluginBuildConfiguration(input.composition, configuration, (plugin) =>
  NodePath.join(input.root, "packages", plugin.id),
);

const verifiedAfterExecution = readManagedPluginComposition(input.root);
if (!NodeUtil.isDeepStrictEqual(verifiedAfterExecution, input.composition)) {
  throw new Error("Managed plugin composition changed while provider validation was running.");
}

const receiptIndex = process.argv.indexOf("--receipt");
const receiptPath = receiptIndex >= 0 ? process.argv[receiptIndex + 1]?.trim() : "";
if (!receiptPath) {
  throw new Error("Managed plugin configuration validation requires --receipt <path>.");
}
NodeFS.writeFileSync(
  NodePath.resolve(receiptPath),
  `${JSON.stringify(
    createManagedPluginValidationReceipt(verifiedAfterExecution, serializedConfiguration),
    null,
    2,
  )}\n`,
  { encoding: "utf8", flag: "wx" },
);
