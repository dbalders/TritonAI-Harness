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

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeBuiltinIntegrations } from "./builtins.ts";
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

export interface IntegrationRuntimeSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export interface IntegrationSkillRuntime {
  readonly root: string;
  readonly skills: ReadonlyArray<IntegrationRuntimeSkill>;
}

interface PersistedIntegrationState {
  readonly version: 1;
  readonly installed: Record<string, { readonly version: string; readonly enabled: boolean }>;
  readonly removing?: Record<string, { readonly version: string; readonly tombstone: string }>;
}

const EMPTY_STATE: PersistedIntegrationState = { version: 1, installed: {}, removing: {} };

export function codexDynamicIntegrationToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 128);
}

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
  #stateMutation: Promise<void> = Promise.resolve();
  readonly #integrationOperations = new Map<string, Promise<void>>();
  readonly #summaries = new Map<string, IntegrationSummary>();
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
    const componentNames = new Set([
      ...manifest.tools.map(({ name }) => name),
      ...manifest.skills.map(({ name }) => name),
    ]);
    const dynamicToolNames = new Map(
      manifest.tools.map(({ name }) => [codexDynamicIntegrationToolName(name), name] as const),
    );
    if (dynamicToolNames.size !== manifest.tools.length) {
      throw new Error("Integration " + manifest.id + " has colliding Codex function names.");
    }
    for (const registered of this.#catalog.values()) {
      const collision = [
        ...registered.manifest.tools.map(({ name }) => name),
        ...registered.manifest.skills.map(({ name }) => name),
      ].find((name) => componentNames.has(name));
      if (collision) {
        throw new Error(
          "Integration component " +
            collision +
            " is already declared by " +
            registered.manifest.id +
            ".",
        );
      }
      for (const registeredTool of registered.manifest.tools) {
        const dynamicName = codexDynamicIntegrationToolName(registeredTool.name);
        const incoming = dynamicToolNames.get(dynamicName);
        if (incoming) {
          throw new Error(
            "Integration tools " +
              registeredTool.name +
              " and " +
              incoming +
              " map to the same Codex function name.",
          );
        }
      }
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
    await NodeFSP.rm(NodePath.join(this.#root, "runtime-skills"), {
      recursive: true,
      force: true,
    });
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

  #serializeState<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#stateMutation.then(operation, operation);
    this.#stateMutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #serializeIntegration<A>(id: string, operation: () => Promise<A>): Promise<A> {
    const previous = this.#integrationOperations.get(id) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#integrationOperations.set(id, tail);
    void tail.then(() => {
      if (this.#integrationOperations.get(id) === tail) this.#integrationOperations.delete(id);
    });
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

  #updateState(
    update: (state: PersistedIntegrationState) => PersistedIntegrationState,
  ): Promise<void> {
    return this.#serializeState(() => this.#save(update(this.#state)));
  }

  #package(id: string): IntegrationPackage {
    const integration = this.#catalog.get(id);
    if (!integration) throw operationError("not_found", `Integration ${id} was not found.`);
    return integration;
  }

  #createSummary(
    manifest: IntegrationManifest,
    providerStatus: IntegrationProviderStatus,
    state: PersistedIntegrationState = this.#state,
  ): IntegrationSummary {
    const installed = state.installed[manifest.id];
    const enabled = installed?.enabled === true;
    const compatibility = activationCompatibility(manifest, installed?.version);
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
  }

  async #summarize(
    { manifest, provider }: IntegrationPackage,
    strictSkillSync = false,
  ): Promise<IntegrationSummary> {
    const installed = this.#state.installed[manifest.id];
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
    let integration = this.#createSummary(manifest, providerStatus);
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
      integration = {
        ...integration,
        statusMessage: integration.statusMessage
          ? `${integration.statusMessage} ${skillMessage}`
          : skillMessage,
        skills: integration.skills.map((skill) => ({ ...skill, available: false })),
      };
    }
    const integrationToolNames = new Set(manifest.tools.map(({ name }) => name));
    this.#availableTools = new Set(
      [...this.#availableTools].filter((name) => !integrationToolNames.has(name)),
    );
    for (const tool of integration.tools) {
      if (tool.available) this.#availableTools.add(tool.name);
    }
    this.#summaries.set(manifest.id, integration);
    return integration;
  }

  #cachedList(): IntegrationsListResult {
    const state = this.#state;
    const unavailable: IntegrationProviderStatus = {
      state: "not_connected",
      accountLabel: null,
      grantedCapabilities: [],
      message: null,
    };
    return {
      integrations: [...this.#catalog.values()].map(({ manifest }) => {
        const summary = this.#summaries.get(manifest.id);
        if (!summary) return this.#createSummary(manifest, unavailable, state);
        const installed = state.installed[manifest.id];
        const enabled = installed?.enabled === true;
        const compatibility = activationCompatibility(manifest, installed?.version);
        if (
          summary.installed === Boolean(installed) &&
          summary.enabled === enabled &&
          summary.compatible === compatibility.compatible
        ) {
          return summary;
        }
        if (!installed) return this.#createSummary(manifest, unavailable, state);
        return {
          ...summary,
          installed: true,
          enabled,
          compatible: compatibility.compatible,
          compatibilityMessage: compatibility.message,
          tools: summary.tools.map((tool) => ({ ...tool, available: false })),
          skills: summary.skills.map((skill) => ({ ...skill, available: false })),
        };
      }),
    };
  }

  async #list(): Promise<IntegrationsListResult> {
    await this.#ready;
    const integrations = await Promise.all(
      [...this.#catalog.values()].map((integration) =>
        this.#serializeIntegration(integration.manifest.id, () => this.#summarize(integration)),
      ),
    );
    return { integrations };
  }

  list(): Promise<IntegrationsListResult> {
    return this.#list();
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

  getAvailableToolDefinitionsSync(): ReadonlyArray<IntegrationProviderTool> {
    return this.toolDefinitions().filter(({ name }) => this.isToolAvailableSync(name));
  }

  getAvailableSkillsSync(): ReadonlyArray<IntegrationRuntimeSkill> {
    return [...this.#catalog.values()].flatMap(({ manifest }) => {
      const installed = this.#state.installed[manifest.id];
      const summary = this.#summaries.get(manifest.id);
      if (!installed || !summary) return [];
      return summary.skills
        .filter(({ available }) => available)
        .map(({ name, description }) => ({
          name,
          description,
          path: NodePath.join(
            this.#root,
            "installed",
            manifest.id,
            installed.version,
            "skills",
            name,
            "SKILL.md",
          ),
        }));
    });
  }

  async prepareSkillRuntime(): Promise<IntegrationSkillRuntime | null> {
    await this.list();
    const skills = this.getAvailableSkillsSync();
    if (skills.length === 0) return null;
    const runtimeParent = NodePath.join(this.#root, "runtime-skills");
    const runtimeRoot = NodePath.join(runtimeParent, crypto.randomUUID());
    const staging = runtimeRoot + ".staging";
    try {
      await NodeFSP.mkdir(staging, { recursive: true, mode: 0o700 });
      for (const skill of skills) {
        const source = NodePath.dirname(skill.path);
        const pending = [source];
        while (pending.length > 0) {
          const directory = pending.pop()!;
          for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
            const path = NodePath.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
              throw new Error("Integration skill " + skill.name + " contains a symbolic link.");
            }
            if (entry.isDirectory()) pending.push(path);
            else if (!entry.isFile()) {
              throw new Error(
                "Integration skill " + skill.name + " contains an unsupported entry.",
              );
            }
          }
        }
        await NodeFSP.cp(source, NodePath.join(staging, skill.name), {
          recursive: true,
          errorOnExist: true,
        });
      }
      await NodeFSP.rename(staging, runtimeRoot);
    } catch (error) {
      await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw operationError(
        "operation_failed",
        "Integration skills could not be prepared: " + safeMessage(error),
      );
    }
    return {
      root: runtimeRoot,
      skills: skills.map((skill) => ({
        ...skill,
        path: NodePath.join(runtimeRoot, skill.name, "SKILL.md"),
      })),
    };
  }

  async releaseSkillRuntime(runtimeRoot: string): Promise<void> {
    const parent = NodePath.resolve(this.#root, "runtime-skills");
    const candidate = NodePath.resolve(runtimeRoot);
    if (NodePath.dirname(candidate) !== parent) return;
    await NodeFSP.rm(candidate, { recursive: true, force: true });
  }

  install(id: string): Promise<IntegrationsListResult> {
    return this.#serializeIntegration(id, async () => {
      await this.#ready;
      const integration = this.#package(id);
      const { manifest, sourceRoot, bundledFiles } = integration;
      const installed = this.#state.installed[id];
      const compatibility = activationCompatibility(manifest, installed?.version);
      if (!compatibility.compatible) throw operationError("incompatible", compatibility.message!);
      if (installed) {
        await this.#summarize(integration);
        return;
      }
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
        await this.#updateState((state) => ({
          ...state,
          installed: { ...state.installed, [id]: { version: manifest.version, enabled: true } },
        }));
        await this.#summarize(integration, true);
      } catch (error) {
        await this.#updateState((state) => {
          const nextInstalled = { ...state.installed };
          delete nextInstalled[id];
          return { ...state, installed: nextInstalled };
        }).catch(() => undefined);
        await this.#skills
          .sync({ integrationId: id, packageRoot: null, activeSkills: [] })
          .catch(() => undefined);
        await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        await NodeFSP.rm(versionRoot, { recursive: true, force: true }).catch(() => undefined);
        await this.#summarize(integration).catch(() => undefined);
        throw operationError(
          "operation_failed",
          `Installation failed without changing active state: ${safeMessage(error)}`,
        );
      }
    }).then(() => this.#cachedList());
  }

  setEnabled(id: string, enabled: boolean): Promise<IntegrationsListResult> {
    const finishRevocation = enabled ? null : this.#beginRevocation(id);
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      const integration = this.#package(id);
      const { manifest } = integration;
      const installed = this.#state.installed[id];
      if (!installed) throw operationError("not_installed", `Integration ${id} is not installed.`);
      const compatibility = activationCompatibility(manifest, installed.version);
      if (enabled && !compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      try {
        if (!enabled) {
          await this.#skills.sync({ integrationId: id, packageRoot: null, activeSkills: [] });
        }
        await this.#updateState((state) => ({
          ...state,
          installed: { ...state.installed, [id]: { ...installed, enabled } },
        }));
        await this.#summarize(integration, enabled);
      } catch (error) {
        await this.#updateState((state) => ({
          ...state,
          installed: { ...state.installed, [id]: installed },
        })).catch(() => undefined);
        await this.#summarize(integration).catch(() => undefined);
        throw operationError(
          "operation_failed",
          `Enablement change was rolled back: ${safeMessage(error)}`,
        );
      }
    });
    const result = operation.then(() => this.#cachedList());
    return finishRevocation ? result.finally(finishRevocation) : result;
  }

  connect(id: string, capabilities: ReadonlyArray<string>): Promise<IntegrationConnectResult> {
    return this.#serializeIntegration(id, async () => {
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
    return this.#serializeIntegration(id, async () => {
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
        return { ...result, integration: await this.#summarize(this.#package(id)) };
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
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      const integration = this.#package(id);
      const { manifest, provider } = integration;
      if (!this.#state.installed[id])
        throw operationError("not_installed", `Integration ${id} is not installed.`);
      try {
        await this.#skills.sync({ integrationId: id, packageRoot: null, activeSkills: [] });
        await provider.disconnect();
        await this.#summarize(integration);
      } catch (error) {
        await this.#summarize(integration).catch(() => undefined);
        throw operationError(
          "operation_failed",
          providerPublicMessage(
            error,
            `${manifest.name} could not disconnect; its installation was preserved.`,
          ),
        );
      }
    });
    return operation.then(() => this.#cachedList()).finally(finishRevocation);
  }

  remove(id: string): Promise<IntegrationsListResult> {
    const finishRevocation = this.#beginRevocation(id);
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      const integration = this.#package(id);
      const { manifest, provider } = integration;
      const installed = this.#state.installed[id];
      if (!installed) {
        await this.#summarize(integration);
        return;
      }
      try {
        await this.#skills.sync({ integrationId: id, packageRoot: null, activeSkills: [] });
        await provider.disconnect();
      } catch (error) {
        await this.#summarize(integration).catch(() => undefined);
        throw operationError(
          "operation_failed",
          providerPublicMessage(
            error,
            `${manifest.name} could not disconnect, so removal stopped before changing installed state.`,
          ),
        );
      }
      const previousRemoval = this.#state.removing?.[id];
      const installedRoot = NodePath.join(this.#root, "installed", id);
      const trashRoot = NodePath.join(this.#root, ".trash");
      const tombstoneName = `${id}.${crypto.randomUUID()}`;
      const tombstone = NodePath.join(trashRoot, tombstoneName);
      let moved = false;
      try {
        await NodeFSP.mkdir(trashRoot, { recursive: true, mode: 0o700 });
        await this.#updateState((state) => ({
          ...state,
          removing: {
            ...state.removing,
            [id]: { version: installed.version, tombstone: tombstoneName },
          },
        }));
        await NodeFSP.rename(installedRoot, tombstone);
        moved = true;
        await this.#updateState((state) => {
          const nextInstalled = { ...state.installed };
          const nextRemovals = { ...state.removing };
          delete nextInstalled[id];
          delete nextRemovals[id];
          return { ...state, installed: nextInstalled, removing: nextRemovals };
        });
      } catch (error) {
        if (moved) await NodeFSP.rename(tombstone, installedRoot).catch(() => undefined);
        await this.#updateState((state) => {
          const nextRemovals = { ...state.removing };
          if (previousRemoval) nextRemovals[id] = previousRemoval;
          else delete nextRemovals[id];
          return {
            ...state,
            installed: { ...state.installed, [id]: installed },
            removing: nextRemovals,
          };
        }).catch(() => undefined);
        await this.#summarize(integration).catch(() => undefined);
        throw operationError(
          "operation_failed",
          `Credentials were removed, but package removal was rolled back: ${safeMessage(error)}`,
        );
      }
      try {
        await this.#removeInstalledPackage(tombstone);
      } catch (error) {
        await this.#summarize(integration).catch(() => undefined);
        throw operationError(
          "operation_failed",
          `${id} was removed, but staged package cleanup will be retried after restart: ${safeMessage(error)}`,
        );
      }
      await this.#summarize(integration);
    });
    return operation.then(() => this.#cachedList()).finally(finishRevocation);
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
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    const skillMaterializer = new CodexIntegrationSkillMaterializer(
      resolveIntegrationCodexHomes(config.baseDir, settings),
    );
    const registry = new RegistryRuntime(
      NodePath.join(config.stateDir, "integrations"),
      makeBuiltinIntegrations(secrets),
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
