// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { canonicalJson, type JsonValue } from "@t3tools/shared/pluginSdkContract";
import { verifyPluginSdkArtifact } from "@t3tools/shared/pluginSdkArtifact";
import { loadPluginSdkIntegration, PluginSdkQuarantineError } from "../pluginSdk/adapter.ts";

it("quarantines a valid SDK1 artifact without evaluating it or supplying secrets", async () => {
  const root = NodePath.join(import.meta.dirname, "../pluginSdk/test-fixtures/synthetic-api-key");
  const files: { path: string; contents: Uint8Array }[] = [];
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(NodePath.join(directory, entry.name), path + "/");
      else
        files.push({
          path,
          contents: await NodeFSP.readFile(NodePath.join(directory, entry.name)),
        });
    }
  };
  await walk(root);
  const marker = "__f06Sdk1Admission";
  const globals = globalThis as unknown as Record<string, unknown>;
  const entry = files.find((file) => file.path === "plugin.mjs")!;
  entry.contents = Buffer.concat([
    Buffer.from(`globalThis[${JSON.stringify(marker)}] = true;\n`),
    entry.contents,
  ]);
  const descriptor = files.find((file) => file.path === "artifact.json")!;
  const value = JSON.parse(Buffer.from(descriptor.contents).toString("utf8")) as {
    files: Array<{ path: string; sha256: string; size: number }>;
  };
  const record = value.files.find((file) => file.path === entry.path)!;
  record.sha256 = NodeCrypto.createHash("sha256").update(entry.contents).digest("hex");
  record.size = entry.contents.byteLength;
  descriptor.contents = Buffer.from(canonicalJson(value as JsonValue) + "\n");
  expect(verifyPluginSdkArtifact(files, { hostNodeVersion: "24.13.1" }).sdkManifest.id).toBe(
    "synthetic-api-key",
  );
  let secretCalls = 0;
  const unexpectedSecret = () => {
    secretCalls++;
    return Effect.die("Secret access is forbidden");
  };
  const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
    get: unexpectedSecret,
    set: unexpectedSecret,
    create: unexpectedSecret,
    getOrCreateRandom: unexpectedSecret,
    remove: unexpectedSecret,
  };
  let loaded: Awaited<ReturnType<typeof loadPluginSdkIntegration>> | undefined;
  let invocations = 0;
  const runtime = {
    workerNodeVersion: "24.22.1",
    invoke: async () => {
      invocations++;
      throw new Error("SDK1 cannot enter the isolated runtime");
    },
  };
  try {
    for (const isolatedRuntime of [undefined, runtime]) {
      await expect(
        loadPluginSdkIntegration({
          files,
          secrets,
          configuration: {},
          expected: { id: "synthetic-api-key", version: "1.0.0" },
          hostNodeVersion: "24.13.1",
          ...(isolatedRuntime ? { isolatedRuntime } : {}),
        }).then((result) => {
          loaded = result;
          return result;
        }),
      ).rejects.toBeInstanceOf(PluginSdkQuarantineError);
      expect(globals[marker]).toBeUndefined();
    }
    expect(invocations).toBe(0);
    expect(secretCalls).toBe(0);
  } finally {
    await loaded?.provider?.close?.();
    delete globals[marker];
  }
});
