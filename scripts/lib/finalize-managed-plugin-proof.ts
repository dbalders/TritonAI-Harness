// @effect-diagnostics nodeBuiltinImport:off,preferSchemaOverJson:off - This validates a build-owned intermediate before binding final artifact bytes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  bindManagedPluginCompositionToArtifacts,
  managedPluginProofFileName,
  managedPluginProofInputFileName,
  type ManagedPluginComposition,
} from "./managed-plugin-composition.ts";

export async function finalizeManagedPluginProof(options: {
  readonly platform: "mac" | "win";
  readonly arch: string;
  readonly artifactPath: string;
  readonly outputDir: string;
}): Promise<string> {
  const extension = options.platform === "mac" ? ".dmg" : ".exe";
  const artifactPath = NodePath.resolve(options.artifactPath);
  const artifactName = NodePath.basename(artifactPath);
  if (!artifactName.endsWith(`-${options.arch}${extension}`)) {
    throw new Error(
      `Final ${options.platform}/${options.arch} artifact name is invalid: ${artifactName}.`,
    );
  }
  const outputDir = NodePath.resolve(options.outputDir);
  const inputPath = NodePath.join(
    outputDir,
    managedPluginProofInputFileName(options.platform, options.arch),
  );
  const outputPath = NodePath.join(
    outputDir,
    managedPluginProofFileName(options.platform, options.arch),
  );
  const composition = JSON.parse(
    await NodeFSP.readFile(inputPath, "utf8"),
  ) as ManagedPluginComposition;
  if (
    composition.version !== 1 ||
    composition.kind !== "tritonai-harness-plugin-composition" ||
    composition.source?.repository !== "https://github.com/dbalders/TritonAI-Plugins.git" ||
    !Array.isArray(composition.packages) ||
    composition.packages.length === 0
  ) {
    throw new Error("Managed plugin proof input has an unsupported contract or provenance.");
  }
  const proof = await bindManagedPluginCompositionToArtifacts(composition, [artifactPath]);
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  await NodeFSP.rename(temporary, outputPath);
  await NodeFSP.rm(inputPath);
  return outputPath;
}
