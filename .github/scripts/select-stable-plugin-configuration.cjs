const fs = require("node:fs");
const path = require("node:path");

// Nightly and stable share credential storage, but each build receives only the
// configuration selected by its immutable plugin composition.
function selectConfiguration(manifest, serialized) {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 16 * 1024) {
    throw new Error("Shared plugin configuration is missing or exceeds the size limit.");
  }
  let shared;
  try {
    shared = JSON.parse(serialized);
  } catch {
    throw new Error("Shared plugin configuration must be valid JSON.");
  }
  if (!shared || typeof shared !== "object" || Array.isArray(shared)) {
    throw new Error("Shared plugin configuration must be an object.");
  }
  if (!Array.isArray(manifest?.packages) || manifest.packages.length === 0) {
    throw new Error("Plugin composition must select at least one package.");
  }
  const selected = Object.create(null);
  const ids = manifest.packages.map((plugin) => plugin.id).sort();
  for (const id of ids) {
    if (
      typeof id !== "string" ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) ||
      Object.hasOwn(selected, id)
    ) {
      throw new Error("Plugin composition contains an invalid or duplicate package ID.");
    }
    const configuration = Object.hasOwn(shared, id) ? shared[id] : undefined;
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      throw new Error("A selected plugin is missing its configuration object.");
    }
    selected[id] = configuration;
  }
  return JSON.stringify(selected);
}

function main(env = process.env) {
  if (!env.TRITONAI_PLUGIN_COMPOSITION_SOURCE || !env.GITHUB_ENV) {
    throw new Error("Plugin composition source and GitHub environment file are required.");
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(env.TRITONAI_PLUGIN_COMPOSITION_SOURCE, "manifest.json"), "utf8"),
  );
  const selected = selectConfiguration(manifest, env.SHARED_PLUGIN_CONFIGURATION_JSON);
  // The selected JSON differs from the stored secret. Register its mask before
  // later steps print their environment headers; escape GitHub command data.
  const masked = selected.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stdout.write(`::add-mask::${masked}\n`);
  // JSON.stringify escapes embedded newlines in the environment file.
  fs.appendFileSync(env.GITHUB_ENV, `TRITONAI_PLUGIN_CONFIGURATION_JSON=${selected}\n`);
}

module.exports = { selectConfiguration, main };
if (require.main === module) main();
