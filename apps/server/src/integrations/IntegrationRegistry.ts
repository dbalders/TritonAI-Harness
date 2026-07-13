// The registry deliberately owns atomic filesystem installation semantics instead of
// exposing the filesystem through its Effect service boundary.
// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off
import type {
  IntegrationConnectResult,
  IntegrationPollResult,
  IntegrationSummary,
  IntegrationsListResult,
} from "@t3tools/contracts";
import { IntegrationOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  manifestCompatibility,
  type IntegrationManifest,
  validateIntegrationManifest,
} from "./manifest.ts";
import {
  CodexIntegrationSkillMaterializer,
  type IntegrationSkillMaterializer,
  noIntegrationSkills,
  resolveIntegrationCodexHomes,
} from "./IntegrationSkillMaterializer.ts";

export interface IntegrationProviderStatus {
  readonly state: "not_connected" | "connecting" | "connected" | "error";
  readonly accountLabel: string | null;
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly message: string | null;
}

export interface IntegrationProviderTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly readOnly: boolean;
  readonly openWorld: boolean;
}

export interface IntegrationInvocationContext {
  readonly signal: AbortSignal;
}

export class IntegrationProviderPublicError extends Error {
  readonly _tag = "IntegrationProviderPublicError";

  constructor(message: string) {
    super(message.trim() || "Integration provider operation failed.");
    this.name = "IntegrationProviderPublicError";
  }
}

export interface IntegrationProvider {
  readonly id: string;
  readonly tools: ReadonlyArray<IntegrationProviderTool>;
  status(): Promise<IntegrationProviderStatus>;
  connect(capabilities: ReadonlyArray<string>): Promise<IntegrationConnectResult>;
  poll(flowId: string): Promise<Omit<IntegrationPollResult, "integration">>;
  disconnect(): Promise<void>;
  invoke(
    toolName: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown>;
}

export interface IntegrationPackage {
  readonly manifest: IntegrationManifest;
  readonly provider: IntegrationProvider;
  readonly sourceRoot?: string;
  readonly bundledFiles?: Readonly<Record<string, string>>;
}

interface PersistedIntegrationState {
  readonly version: 1;
  readonly installed: Record<string, { readonly version: string; readonly enabled: boolean }>;
  readonly removing?: Record<string, { readonly version: string; readonly tombstone: string }>;
}

const EMPTY_STATE: PersistedIntegrationState = { version: 1, installed: {}, removing: {} };

function operationError(
  code: ConstructorParameters<typeof IntegrationOperationError>[0]["code"],
  message: string,
) {
  return new IntegrationOperationError({ code, message });
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Integration operation failed.";
}

function providerPublicMessage(error: unknown, fallback: string): string {
  return error instanceof Error &&
    "_tag" in error &&
    error._tag === "IntegrationProviderPublicError" &&
    error.message.trim()
    ? error.message
    : fallback;
}

function activationCompatibility(
  manifest: IntegrationManifest,
  installedVersion?: string,
): { readonly compatible: boolean; readonly message: string | null } {
  if (installedVersion && installedVersion !== manifest.version) {
    return {
      compatible: false,
      message: `Installed version ${installedVersion} does not match discovered version ${manifest.version}. Remove and reinstall it before activation.`,
    };
  }
  return manifestCompatibility(manifest);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  } catch (error) {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function validateStagedPackage(root: string, expected: IntegrationManifest): Promise<void> {
  const rootEntry = await NodeFSP.lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error("The staged integration package root must be a real directory.");
  }
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Integration packages cannot contain symlinks.");
      if (entry.isDirectory()) pending.push(path);
      else if (!entry.isFile()) throw new Error("Integration packages can contain only files.");
    }
  }
  const installed = validateIntegrationManifest(
    JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, ".tritonai-plugin", "plugin.json"), "utf8"),
    ),
  );
  if (
    installed.apiVersion !== expected.apiVersion ||
    installed.kind !== expected.kind ||
    installed.manifestVersion !== expected.manifestVersion ||
    installed.id !== expected.id ||
    installed.name !== expected.name ||
    installed.description !== expected.description ||
    installed.version !== expected.version ||
    installed.provider !== expected.provider ||
    JSON.stringify(installed.compatibility) !== JSON.stringify(expected.compatibility) ||
    JSON.stringify(installed.capabilities) !== JSON.stringify(expected.capabilities) ||
    JSON.stringify(installed.tools) !== JSON.stringify(expected.tools) ||
    JSON.stringify(installed.skills) !== JSON.stringify(expected.skills)
  ) {
    throw new Error("The staged manifest changed after discovery.");
  }
  for (const skill of expected.skills) {
    const skillPath = NodePath.join(root, "skills", skill.name, "SKILL.md");
    if (
      !(await NodeFSP.stat(skillPath)
        .then((value) => value.isFile())
        .catch(() => false))
    ) {
      throw new Error(`Integration package is missing skills/${skill.name}/SKILL.md.`);
    }
  }
}

export class RegistryRuntime {
  readonly #root: string;
  readonly #statePath: string;
  readonly #catalog = new Map<string, IntegrationPackage>();
  readonly #toolObservers = new Set<(definition: IntegrationProviderTool) => void>();
  #state: PersistedIntegrationState = EMPTY_STATE;
  #ready: Promise<void>;
  #mutation: Promise<void> = Promise.resolve();
  #availableTools = new Set<string>();
  readonly #revocations = new Map<string, number>();
  readonly #activeInvocations = new Map<string, Set<AbortController>>();
  readonly #skills: IntegrationSkillMaterializer;
  readonly #removeInstalledPackage: (path: string) => Promise<void>;

  constructor(
    root: string,
    packages: ReadonlyArray<IntegrationPackage>,
    skills: IntegrationSkillMaterializer = noIntegrationSkills,
    removeInstalledPackage: (path: string) => Promise<void> = (path) =>
      NodeFSP.rm(path, { recursive: true, force: true }),
  ) {
    this.#root = root;
    this.#statePath = NodePath.join(root, "state.json");
    this.#skills = skills;
    this.#removeInstalledPackage = removeInstalledPackage;
    for (const integration of packages) this.register(integration);
    this.#ready = this.#load();
  }

  register(integration: IntegrationPackage): void {
    const manifest = validateIntegrationManifest(integration.manifest);
    if (this.#catalog.has(manifest.id)) {
      throw new Error(`Integration ${manifest.id} is already registered.`);
    }
    if (manifest.provider !== integration.provider.id) {
      throw new Error(
        `Manifest provider ${manifest.provider} does not match ${integration.provider.id}.`,
      );
    }
    const manifestToolNames = new Set(manifest.tools.map(({ name }) => name));
    const providerToolNames = new Set(integration.provider.tools.map(({ name }) => name));
    if (
      manifestToolNames.size !== providerToolNames.size ||
      [...manifestToolNames].some((name) => !providerToolNames.has(name))
    ) {
      throw new Error(
        `Provider ${integration.provider.id} tool definitions do not match its manifest.`,
      );
    }
    for (const definition of integration.provider.tools) {
      if (!definition.readOnly) {
        throw new Error(
          `Provider ${integration.provider.id} tool ${definition.name} is not read-only; write-capable integration tools are not supported.`,
        );
      }
      for (const existing of this.#catalog.values()) {
        if (existing.provider.tools.some(({ name }) => name === definition.name)) {
          throw new Error(`Integration tool ${definition.name} is already registered.`);
        }
      }
    }
    this.#catalog.set(manifest.id, {
      manifest,
      provider: integration.provider,
      ...(integration.sourceRoot ? { sourceRoot: integration.sourceRoot } : {}),
      ...(integration.bundledFiles ? { bundledFiles: integration.bundledFiles } : {}),
    });
    for (const definition of integration.provider.tools) {
      for (const observer of this.#toolObservers) observer(definition);
    }
  }

  observeToolDefinitions(observer: (definition: IntegrationProviderTool) => void): () => void {
    for (const definition of this.toolDefinitions()) observer(definition);
    this.#toolObservers.add(observer);
    return () => this.#toolObservers.delete(observer);
  }

  async discoverPackage(packageRoot: string, provider: IntegrationProvider): Promise<void> {
    const raw = await NodeFSP.readFile(
      NodePath.join(packageRoot, ".tritonai-plugin", "plugin.json"),
      "utf8",
    );
    this.register({
      manifest: validateIntegrationManifest(JSON.parse(raw)),
      provider,
      sourceRoot: packageRoot,
    });
  }

  async #load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await NodeFSP.readFile(this.#statePath, "utf8"),
      ) as PersistedIntegrationState;
      if (parsed.version !== 1 || !parsed.installed || typeof parsed.installed !== "object") {
        throw new Error("Unsupported integration state version.");
      }
      if (parsed.removing !== undefined && typeof parsed.removing !== "object") {
        throw new Error("Unsupported integration removal state.");
      }
      this.#state = { ...parsed, removing: parsed.removing ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.#reconcileRemovals();
    const trashRoot = NodePath.join(this.#root, ".trash");
    try {
      await NodeFSP.access(trashRoot);
      await this.#removeInstalledPackage(trashRoot).catch(() => undefined);
    } catch {}
  }

  async #reconcileRemovals(): Promise<void> {
    for (const [id, removal] of Object.entries(this.#state.removing ?? {})) {
      if (
        !/^[a-z][a-z0-9.-]*$/u.test(id) ||
        !removal ||
        typeof removal.version !== "string" ||
        typeof removal.tombstone !== "string" ||
        NodePath.basename(removal.tombstone) !== removal.tombstone ||
        !removal.tombstone.startsWith(`${id}.`)
      ) {
        throw new Error(`Invalid removal recovery record for ${id}.`);
      }
      const installedRoot = NodePath.join(this.#root, "installed", id);
      const trashRoot = NodePath.join(this.#root, ".trash");
      const tombstone = NodePath.join(trashRoot, removal.tombstone);
      const installedExists = await NodeFSP.access(installedRoot)
        .then(() => true)
        .catch(() => false);
      const tombstoneExists = await NodeFSP.access(tombstone)
        .then(() => true)
        .catch(() => false);
      if (installedExists && tombstoneExists) {
        throw new Error(`Removal recovery found both installed and tombstoned copies for ${id}.`);
      }
      if (installedExists) {
        await NodeFSP.mkdir(trashRoot, { recursive: true, mode: 0o700 });
        await NodeFSP.rename(installedRoot, tombstone);
      }
      const { [id]: _installed, ...remainingInstalled } = this.#state.installed;
      const { [id]: _removal, ...remainingRemovals } = this.#state.removing ?? {};
      await this.#save({
        version: 1,
        installed: remainingInstalled,
        removing: remainingRemovals,
      });
      await this.#removeInstalledPackage(tombstone).catch(() => undefined);
    }
  }

  #serialize<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#mutation.then(operation, operation);
    this.#mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #beginRevocation(id: string): () => void {
    this.#revocations.set(id, (this.#revocations.get(id) ?? 0) + 1);
    for (const controller of this.#activeInvocations.get(id) ?? []) controller.abort();
    return () => {
      const remaining = (this.#revocations.get(id) ?? 1) - 1;
      if (remaining > 0) this.#revocations.set(id, remaining);
      else this.#revocations.delete(id);
    };
  }

  #isRevoking(id: string): boolean {
    return this.#revocations.has(id);
  }

  async #save(state: PersistedIntegrationState): Promise<void> {
    const normalized = { ...state, removing: state.removing ?? {} };
    await atomicJson(this.#statePath, normalized);
    this.#state = normalized;
  }

  #package(id: string): IntegrationPackage {
    const integration = this.#catalog.get(id);
    if (!integration) throw operationError("not_found", `Integration ${id} was not found.`);
    return integration;
  }

  async #list(strictSkillSync = false): Promise<IntegrationsListResult> {
    await this.#ready;
    const integrations = await Promise.all(
      [...this.#catalog.values()].map(
        async ({ manifest, provider }): Promise<IntegrationSummary> => {
          const installed = this.#state.installed[manifest.id];
          const enabled = installed?.enabled === true;
          const compatibility = activationCompatibility(manifest, installed?.version);
          let providerStatus: IntegrationProviderStatus = {
            state: "not_connected",
            accountLabel: null,
            grantedCapabilities: [],
            message: null,
          };
          if (installed && compatibility.compatible) {
            try {
              providerStatus = await provider.status();
            } catch {
              providerStatus = {
                state: "error",
                accountLabel: null,
                grantedCapabilities: [],
                message: "The integration provider could not report its status.",
              };
            }
          }
          const available = (capability: string) =>
            Boolean(
              installed &&
              enabled &&
              compatibility.compatible &&
              providerStatus.state === "connected" &&
              providerStatus.grantedCapabilities.includes(capability),
            );
          return {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            apiVersion: manifest.apiVersion,
            installed: Boolean(installed),
            enabled,
            compatible: compatibility.compatible,
            compatibilityMessage: compatibility.message,
            connectionState: providerStatus.state,
            accountLabel: providerStatus.accountLabel,
            statusMessage: providerStatus.message,
            capabilities: manifest.capabilities.map((capability) => ({
              ...capability,
              granted: providerStatus.grantedCapabilities.includes(capability.id),
            })),
            tools: manifest.tools.map((tool) => ({
              ...tool,
              available: available(tool.capability),
            })),
            skills: manifest.skills.map((skill) => ({
              ...skill,
              available: available(skill.capability),
            })),
          };
        },
      ),
    );
    for (let index = 0; index < integrations.length; index += 1) {
      const integration = integrations[index]!;
      const installed = this.#state.installed[integration.id];
      try {
        await this.#skills.sync({
          integrationId: integration.id,
          packageRoot: installed
            ? NodePath.join(this.#root, "installed", integration.id, installed.version)
            : null,
          activeSkills: integration.skills
            .filter(({ available }) => available)
            .map(({ name }) => name),
        });
      } catch (error) {
        if (strictSkillSync) throw error;
        await this.#skills
          .sync({ integrationId: integration.id, packageRoot: null, activeSkills: [] })
          .catch(() => undefined);
        const skillMessage = `Bundled skills could not be activated: ${safeMessage(error)}`;
        integrations[index] = {
          ...integration,
          statusMessage: integration.statusMessage
            ? `${integration.statusMessage} ${skillMessage}`
            : skillMessage,
          skills: integration.skills.map((skill) => ({ ...skill, available: false })),
        };
      }
    }
    this.#availableTools = new Set(
      integrations.flatMap((integration) =>
        integration.tools.filter((tool) => tool.available).map((tool) => tool.name),
      ),
    );
    return { integrations };
  }

  list(): Promise<IntegrationsListResult> {
    return this.#serialize(() => this.#list());
  }

  isToolAvailableSync(name: string): boolean {
    if (!this.#availableTools.has(name)) return false;
    for (const { manifest } of this.#catalog.values()) {
      if (manifest.tools.some((tool) => tool.name === name)) return !this.#isRevoking(manifest.id);
    }
    return false;
  }

  hasAvailableToolsSync(): boolean {
    return [...this.#availableTools].some((name) => this.isToolAvailableSync(name));
  }

  toolDefinitions(): ReadonlyArray<IntegrationProviderTool> {
    return [...this.#catalog.values()].flatMap(({ provider }) => provider.tools);
  }

  install(id: string): Promise<IntegrationsListResult> {
    return this.#serialize(async () => {
      await this.#ready;
      const { manifest, sourceRoot, bundledFiles } = this.#package(id);
      const installed = this.#state.installed[id];
      const compatibility = activationCompatibility(manifest, installed?.version);
      if (!compatibility.compatible) throw operationError("incompatible", compatibility.message!);
      if (installed) return this.#list();
      const previous = this.#state;
      const versionRoot = NodePath.join(this.#root, "installed", id, manifest.version);
      const staging = `${versionRoot}.${crypto.randomUUID()}.staging`;
      try {
        if (sourceRoot) {
          const sourceEntry = await NodeFSP.lstat(sourceRoot);
          if (sourceEntry.isSymbolicLink() || !sourceEntry.isDirectory()) {
            throw new Error("The integration package source root must be a real directory.");
          }
          await NodeFSP.cp(sourceRoot, staging, { recursive: true, errorOnExist: true });
        } else if (bundledFiles) {
          for (const [relativePath, contents] of Object.entries(bundledFiles)) {
            if (NodePath.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
              throw new Error(`Bundled integration file path ${relativePath} is unsafe.`);
            }
            const target = NodePath.join(staging, relativePath);
            await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
            await NodeFSP.writeFile(target, contents, { mode: 0o600 });
          }
        } else {
          // Inline packages are useful for tests and embedders; production catalog packages
          // provide a complete sourceRoot so installation stages the manifest and bundled assets.
          await NodeFSP.mkdir(NodePath.join(staging, ".tritonai-plugin"), {
            recursive: true,
            mode: 0o700,
          });
          await NodeFSP.writeFile(
            NodePath.join(staging, ".tritonai-plugin", "plugin.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
            { mode: 0o600 },
          );
        }
        await validateStagedPackage(staging, manifest);
        await NodeFSP.mkdir(NodePath.dirname(versionRoot), { recursive: true, mode: 0o700 });
        await NodeFSP.rename(staging, versionRoot);
        await this.#save({
          version: 1,
          installed: {
            ...this.#state.installed,
            [id]: { version: manifest.version, enabled: true },
          },
        });
        return await this.#list(true);
      } catch (error) {
        await this.#save(previous).catch(() => undefined);
        await this.#skills
          .sync({ integrationId: id, packageRoot: null, activeSkills: [] })
          .catch(() => undefined);
        await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        await NodeFSP.rm(versionRoot, { recursive: true, force: true }).catch(() => undefined);
        await this.#list().catch(() => undefined);
        throw operationError(
          "operation_failed",
          `Installation failed without changing active state: ${safeMessage(error)}`,
        );
      }
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<IntegrationsListResult> {
    const finishRevocation = enabled ? null : this.#beginRevocation(id);
    const operation = this.#serialize(async () => {
      await this.#ready;
      const { manifest } = this.#package(id);
      const installed = this.#state.installed[id];
      if (!installed) throw operationError("not_installed", `Integration ${id} is not installed.`);
      const compatibility = activationCompatibility(manifest, installed.version);
      if (enabled && !compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      const previous = this.#state;
      try {
        if (!enabled) {
          await this.#skills.sync({ integrationId: id, packageRoot: null, activeSkills: [] });
        }
        await this.#save({
          version: 1,
          installed: { ...this.#state.installed, [id]: { ...installed, enabled } },
        });
        return await this.#list(enabled);
      } catch (error) {
        await this.#save(previous).catch(() => undefined);
        await this.#list().catch(() => undefined);
        throw operationError(
          "operation_failed",
          `Enablement change was rolled back: ${safeMessage(error)}`,
        );
      }
    });
    return finishRevocation ? operation.finally(finishRevocation) : operation;
  }

  connect(id: string, capabilities: ReadonlyArray<string>): Promise<IntegrationConnectResult> {
    return this.#serialize(async () => {
      await this.#ready;
      const { manifest, provider } = this.#package(id);
      const installed = this.#state.installed[id];
      if (!installed) throw operationError("not_installed", `Integration ${id} is not installed.`);
      const compatibility = activationCompatibility(manifest, installed.version);
      if (!compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      if (!installed.enabled) {
        throw operationError("disabled", `Enable ${manifest.name} before connecting.`);
      }
      const allowed = new Set(manifest.capabilities.map(({ id: capability }) => capability));
      if (!capabilities.length || capabilities.some((capability) => !allowed.has(capability))) {
        throw operationError("capability_required", "Choose one or more supported capabilities.");
      }
      try {
        return await provider.connect([...new Set(capabilities)]);
      } catch (error) {
        throw operationError(
          "operation_failed",
          providerPublicMessage(
            error,
            `${manifest.name} authorization could not start. Try again.`,
          ),
        );
      }
    });
  }

  poll(id: string, flowId: string): Promise<IntegrationPollResult> {
    return this.#serialize(async () => {
      await this.#ready;
      const { manifest, provider } = this.#package(id);
      const installed = this.#state.installed[id];
      if (!installed) throw operationError("not_installed", `Integration ${id} is not installed.`);
      const compatibility = activationCompatibility(manifest, installed.version);
      if (!compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      if (!installed.enabled) {
        throw operationError("disabled", `${manifest.name} is disabled.`);
      }
      try {
        const result = await provider.poll(flowId);
        const integration = (await this.#list()).integrations.find((item) => item.id === id)!;
        return { ...result, integration };
      } catch (error) {
        throw operationError(
          "operation_failed",
          providerPublicMessage(
            error,
            `${manifest.name} authorization status could not be checked. Try again.`,
          ),
        );
      }
    });
  }

  disconnect(id: string): Promise<IntegrationsListResult> {
    const finishRevocation = this.#beginRevocation(id);
    return this.#serialize(async () => {
      await this.#ready;
      const { manifest, provider } = this.#package(id);
      if (!this.#state.installed[id])
        throw operationError("not_installed", `Integration ${id} is not installed.`);
      try {
        await this.#skills.sync({ integrationId: id, packageRoot: null, activeSkills: [] });
        await provider.disconnect();
      } catch (error) {
        await this.#list().catch(() => undefined);
        throw operationError(
          "operation_failed",
          providerPublicMessage(
            error,
            `${manifest.name} could not disconnect; its installation was preserved.`,
          ),
        );
      }
      return this.#list();
    }).finally(finishRevocation);
  }

  remove(id: string): Promise<IntegrationsListResult> {
    const finishRevocation = this.#beginRevocation(id);
    return this.#serialize(async () => {
      await this.#ready;
      const { manifest, provider } = this.#package(id);
      const installed = this.#state.installed[id];
      if (!installed) return this.#list();
      try {
        await this.#skills.sync({ integrationId: id, packageRoot: null, activeSkills: [] });
        await provider.disconnect();
      } catch (error) {
        await this.#list().catch(() => undefined);
        throw operationError(
          "operation_failed",
          providerPublicMessage(
            error,
            `${manifest.name} could not disconnect, so removal stopped before changing installed state.`,
          ),
        );
      }
      const previous = this.#state;
      const { [id]: _, ...remaining } = this.#state.installed;
      const installedRoot = NodePath.join(this.#root, "installed", id);
      const trashRoot = NodePath.join(this.#root, ".trash");
      const tombstoneName = `${id}.${crypto.randomUUID()}`;
      const tombstone = NodePath.join(trashRoot, tombstoneName);
      let moved = false;
      try {
        await NodeFSP.mkdir(trashRoot, { recursive: true, mode: 0o700 });
        await this.#save({
          ...this.#state,
          removing: {
            ...this.#state.removing,
            [id]: { version: installed.version, tombstone: tombstoneName },
          },
        });
        await NodeFSP.rename(installedRoot, tombstone);
        moved = true;
        const { [id]: _removal, ...remainingRemovals } = this.#state.removing ?? {};
        await this.#save({ version: 1, installed: remaining, removing: remainingRemovals });
      } catch (error) {
        if (moved) await NodeFSP.rename(tombstone, installedRoot).catch(() => undefined);
        await this.#save(previous).catch(() => undefined);
        await this.#list().catch(() => undefined);
        throw operationError(
          "operation_failed",
          `Credentials were removed, but package removal was rolled back: ${safeMessage(error)}`,
        );
      }
      try {
        await this.#removeInstalledPackage(tombstone);
      } catch (error) {
        await this.#list().catch(() => undefined);
        throw operationError(
          "operation_failed",
          `${id} was removed, but staged package cleanup will be retried after restart: ${safeMessage(error)}`,
        );
      }
      return this.#list();
    }).finally(finishRevocation);
  }

  async invokeTool(name: string, input: unknown): Promise<unknown> {
    await this.#ready;
    for (const { manifest, provider } of this.#catalog.values()) {
      const tool = manifest.tools.find((candidate) => candidate.name === name);
      if (!tool) continue;
      if (this.#isRevoking(manifest.id)) {
        throw operationError("disabled", `${manifest.name} access is being revoked.`);
      }
      const installed = this.#state.installed[manifest.id];
      if (!installed?.enabled) {
        throw operationError("disabled", `${manifest.name} is not enabled.`);
      }
      const compatibility = activationCompatibility(manifest, installed.version);
      if (!compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      const controller = new AbortController();
      const active = this.#activeInvocations.get(manifest.id) ?? new Set<AbortController>();
      active.add(controller);
      this.#activeInvocations.set(manifest.id, active);
      try {
        const status = await provider.status();
        if (controller.signal.aborted || this.#isRevoking(manifest.id)) {
          throw operationError("disabled", `${manifest.name} access is being revoked.`);
        }
        if (status.state !== "connected") {
          throw operationError("not_connected", `${manifest.name} is not connected.`);
        }
        if (!status.grantedCapabilities.includes(tool.capability)) {
          throw operationError(
            "capability_required",
            `${tool.displayName} requires ${tool.capability}.`,
          );
        }
        const result = await provider.invoke(name, input, { signal: controller.signal });
        if (controller.signal.aborted) {
          throw operationError("disabled", `${manifest.name} access was revoked.`);
        }
        return result;
      } catch (error) {
        if (controller.signal.aborted) {
          throw operationError("disabled", `${manifest.name} access was revoked.`);
        }
        throw error;
      } finally {
        active.delete(controller);
        if (active.size === 0) this.#activeInvocations.delete(manifest.id);
      }
    }
    throw operationError("not_found", `Integration tool ${name} was not found.`);
  }
}

let activeRegistry: RegistryRuntime | null = null;
const registryObservers = new Set<(registry: RegistryRuntime) => void>();

export function getIntegrationRegistry(): RegistryRuntime {
  if (!activeRegistry) throw new Error("Integration registry has not started.");
  return activeRegistry;
}

export function getIntegrationRegistryOptional(): RegistryRuntime | null {
  return activeRegistry;
}

export function observeIntegrationRegistry(
  observer: (registry: RegistryRuntime) => void,
): () => void {
  if (activeRegistry) observer(activeRegistry);
  registryObservers.add(observer);
  return () => registryObservers.delete(observer);
}

export const startupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    const skillMaterializer = new CodexIntegrationSkillMaterializer(
      resolveIntegrationCodexHomes(config.baseDir, settings),
    );
    const registry = new RegistryRuntime(
      NodePath.join(config.stateDir, "integrations"),
      [],
      skillMaterializer,
    );
    yield* Effect.promise(() => registry.list());
    activeRegistry = registry;
    for (const observer of registryObservers) observer(registry);
    yield* settingsService.streamChanges.pipe(
      Stream.runForEach((nextSettings) =>
        Effect.tryPromise({
          try: async () => {
            await skillMaterializer.setCodexHomes(
              resolveIntegrationCodexHomes(config.baseDir, nextSettings),
            );
            await registry.list();
          },
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.void)),
      ),
      Effect.forkScoped,
    );
  }),
);
