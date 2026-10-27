import type { PluginSdkArtifactFile } from "@t3tools/shared/pluginSdkArtifact";
import type * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import type { IntegrationPackage } from "../IntegrationRegistry.ts";
import {
  loadIsolatedPluginIntegration,
  type IsolatedPluginRuntime,
} from "../pluginSandbox/IsolatedPluginAdapter.ts";

export class PluginSdkQuarantineError extends Error {
  constructor(cause?: unknown) {
    super("A plugin provider was quarantined.", cause === undefined ? undefined : { cause });
    this.name = "PluginSdkQuarantineError";
  }
}

export async function loadPluginSdkIntegration(input: {
  readonly files: ReadonlyArray<PluginSdkArtifactFile>;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly expected: { readonly id: string; readonly version: string };
  readonly hostNodeVersion?: string | null;
  readonly isolatedRuntime?: IsolatedPluginRuntime;
}): Promise<IntegrationPackage> {
  try {
    if (!input.isolatedRuntime)
      throw new Error("This host has no admitted isolated plugin runtime.");
    return await loadIsolatedPluginIntegration({ ...input, runtime: input.isolatedRuntime });
  } catch (error) {
    throw new PluginSdkQuarantineError(error);
  }
}
