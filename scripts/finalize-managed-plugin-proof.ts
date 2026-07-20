#!/usr/bin/env node

import { finalizeManagedPluginProof } from "./lib/finalize-managed-plugin-proof.ts";

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

const platform = argument("platform");
if (platform !== "mac" && platform !== "win") throw new Error("--platform must be mac or win.");
const outputPath = await finalizeManagedPluginProof({
  platform,
  arch: argument("arch"),
  artifactPath: argument("artifact"),
  outputDir: argument("output-dir"),
});
process.stdout.write(`Finalized managed plugin proof: ${outputPath}\n`);
