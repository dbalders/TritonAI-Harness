// The registry deliberately owns atomic filesystem installation semantics instead of
// exposing the filesystem through its Effect service boundary.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off cryptoRandomUUID:off
import {
  IntegrationConnectResult,
  IntegrationProviderPollResult,
  IntegrationOperationError,
  type IntegrationConnectionSubmission,
  type IntegrationProviderPollResult as IntegrationProviderPollResultType,
  type IntegrationPollResult,
  type IntegrationSummary,
  type IntegrationsListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeBuiltinIntegrations } from "./builtins.ts";
import {
  isIntegrationId,
  isIntegrationSkillName,
  isIntegrationVersion,
  manifestCompatibility,
  type IntegrationManifest,
  validateIntegrationManifest,
} from "./manifest.ts";
import {
  CodexIntegrationSkillMaterializer,
  declaredIntegrationSkillName,
  type IntegrationSkillMaterializer,
  type IntegrationSkillSync,
  noIntegrationSkills,
  resolveIntegrationCodexHomes,
} from "./IntegrationSkillMaterializer.ts";
import {
  decodeIntegrationToolInput,
  integrationToolJsonSchema,
  type IntegrationProviderTool,
} from "./IntegrationTool.ts";

export type { IntegrationProviderTool } from "./IntegrationTool.ts";

export interface IntegrationProviderStatus {
  readonly state: "not_connected" | "connecting" | "connected" | "error";
  readonly accountLabel: string | null;
  readonly grantedCapabilities: ReadonlyArray<string>;
  readonly message: string | null;
}

export interface IntegrationInvocationContext {
  readonly signal: AbortSignal;
  /** Set only by a Harness host after resolving the write-tool approval UI. */
  readonly writeApproved?: boolean;
}

export interface IntegrationLifecycleContext extends IntegrationInvocationContext {
  /**
   * Admit the provider's final external commit point. The provider must await this immediately
   * before a narrow, internally bounded commit tail and recover before rejecting that tail. The
   * host journals admission first, rejects admission when cancellation already won, and faults the
   * provider if the admitted tail outlives its watchdog. Fallible commit-tail work must use the
   * returned signal, which aborts shortly before that watchdog fires.
   */
  beginCommit(): Promise<AbortSignal>;
}

export class IntegrationProviderPublicError extends Error {
  readonly _tag = "IntegrationProviderPublicError";

  constructor(message: string) {
    super(message.trim() || "Integration provider operation failed.");
    this.name = "IntegrationProviderPublicError";
  }
}

/** Every context-aware method must settle promptly after its AbortSignal aborts. */
export interface IntegrationProvider {
  readonly id: string;
  readonly tools: ReadonlyArray<IntegrationProviderTool>;
  /** Status is observational only. Provider work must settle promptly after its signal aborts. */
  status(context?: IntegrationInvocationContext): Promise<IntegrationProviderStatus>;
  connect?(
    capabilities: ReadonlyArray<string>,
    context?: IntegrationLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationConnectResult>;
  poll?(
    flowId: string,
    context?: IntegrationLifecycleContext,
  ): Promise<IntegrationProviderPollResultType>;
  disconnect?(context?: IntegrationLifecycleContext): Promise<void>;
  invoke(
    toolName: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown>;
  /** Close must be idempotent and tolerate previously aborted provider work. */
  close?(): Promise<void>;
}

type ConnectedIntegrationProvider = IntegrationProvider &
  Required<Pick<IntegrationProvider, "connect" | "disconnect">>;

type PollingIntegrationProvider = ConnectedIntegrationProvider &
  Required<Pick<IntegrationProvider, "poll">>;

function hasConnectionLifecycle(
  provider: IntegrationProvider | undefined,
): provider is ConnectedIntegrationProvider {
  return Boolean(
    provider && typeof provider.connect === "function" && typeof provider.disconnect === "function",
  );
}

function hasPollingLifecycle(
  provider: IntegrationProvider | undefined,
): provider is PollingIntegrationProvider {
  return hasConnectionLifecycle(provider) && typeof provider.poll === "function";
}

export interface IntegrationPackage {
  readonly manifest: IntegrationManifest;
  readonly provider?: IntegrationProvider;
  readonly sourceRoot?: string;
  readonly bundledFiles?: Readonly<Record<string, string>>;
}

export interface IntegrationRuntimeSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export interface PreparedIntegrationRuntimeSkill extends IntegrationRuntimeSkill {
  readonly root: string;
}

export interface IntegrationSkillRuntime {
  readonly root: string;
  readonly skills: ReadonlyArray<PreparedIntegrationRuntimeSkill>;
}

export interface IntegrationSkillReservation {
  readonly release: () => void;
}

export interface IntegrationAvailabilityChange {
  readonly generation: number;
  readonly skills: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
}

interface PersistedIntegrationState {
  readonly version: 1;
  readonly installed: Record<
    string,
    {
      readonly version: string;
      readonly enabled: boolean;
      readonly enabledCapabilities?: ReadonlyArray<string>;
      /** Legacy v1 state accepted only for migration; capability access now owns availability. */
      readonly disabledSkills?: ReadonlyArray<string>;
    }
  >;
  readonly removing?: Record<string, { readonly version: string; readonly tombstone: string }>;
}

type InstalledIntegrationState = PersistedIntegrationState["installed"][string];
type RemovingIntegrationState = NonNullable<PersistedIntegrationState["removing"]>[string];

export interface RegistryRuntimeOptions {
  readonly providerStatusTimeoutMs?: number;
  readonly providerOperationTimeoutMs?: number;
}

const DEFAULT_PROVIDER_STATUS_TIMEOUT_MS = 5_000;
const DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS = 30_000;
const decodeProviderConnectResult = Schema.decodeUnknownPromise(IntegrationConnectResult);
const decodeProviderPollResult = Schema.decodeUnknownPromise(IntegrationProviderPollResult);

function emptyRecord<A>(): Record<string, A> {
  return Object.create(null) as Record<string, A>;
}

function copyOwnRecord<A>(record: Readonly<Record<string, A>> | undefined): Record<string, A> {
  const copy = emptyRecord<A>();
  for (const [key, value] of Object.entries(record ?? {})) copy[key] = value;
  return copy;
}

function hasOwnRecordKey<A>(record: Readonly<Record<string, A>> | undefined, key: string): boolean {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key);
}

function ownRecordValue<A>(
  record: Readonly<Record<string, A>> | undefined,
  key: string,
): A | undefined {
  return hasOwnRecordKey(record, key) ? record![key] : undefined;
}

function withoutOwnKey<A>(
  record: Readonly<Record<string, A>> | undefined,
  key: string,
): Record<string, A> {
  const copy = copyOwnRecord(record);
  delete copy[key];
  return copy;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function decodePersistedState(value: unknown): PersistedIntegrationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Integration state must be an object.");
  }
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    !hasOnlyKeys(state, new Set(["version", "installed", "removing"])) ||
    !state.installed ||
    typeof state.installed !== "object" ||
    Array.isArray(state.installed) ||
    (state.removing !== undefined &&
      (!state.removing || typeof state.removing !== "object" || Array.isArray(state.removing)))
  ) {
    throw new Error("Unsupported integration state version or shape.");
  }
  const installed = emptyRecord<InstalledIntegrationState>();
  for (const [id, raw] of Object.entries(state.installed as Record<string, unknown>)) {
    if (!isIntegrationId(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid installed integration state for ${id}.`);
    }
    const entry = raw as Record<string, unknown>;
    const disabledSkills = entry.disabledSkills;
    const enabledCapabilities = entry.enabledCapabilities;
    if (
      !hasOnlyKeys(
        entry,
        new Set(["version", "enabled", "enabledCapabilities", "disabledSkills"]),
      ) ||
      !isIntegrationVersion(entry.version) ||
      typeof entry.enabled !== "boolean" ||
      (enabledCapabilities !== undefined &&
        (!Array.isArray(enabledCapabilities) ||
          enabledCapabilities.some((capability) => !isIntegrationId(capability)) ||
          new Set(enabledCapabilities).size !== enabledCapabilities.length)) ||
      (disabledSkills !== undefined &&
        (!Array.isArray(disabledSkills) ||
          disabledSkills.some((skill) => !isIntegrationSkillName(skill)) ||
          new Set(disabledSkills).size !== disabledSkills.length))
    ) {
      throw new Error(`Invalid installed integration state for ${id}.`);
    }
    installed[id] = {
      version: entry.version,
      enabled: entry.enabled,
      ...(enabledCapabilities
        ? {
            enabledCapabilities: [...(enabledCapabilities as ReadonlyArray<string>)].toSorted(),
          }
        : {}),
      ...(disabledSkills
        ? { disabledSkills: [...(disabledSkills as ReadonlyArray<string>)].toSorted() }
        : {}),
    };
  }
  const removing = emptyRecord<RemovingIntegrationState>();
  for (const [id, raw] of Object.entries((state.removing ?? {}) as Record<string, unknown>)) {
    if (!isIntegrationId(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Invalid removal recovery record for ${id}.`);
    }
    const entry = raw as Record<string, unknown>;
    if (
      !hasOnlyKeys(entry, new Set(["version", "tombstone"])) ||
      !isIntegrationVersion(entry.version) ||
      typeof entry.tombstone !== "string" ||
      NodePath.basename(entry.tombstone) !== entry.tombstone ||
      !entry.tombstone.startsWith(`${id}.`)
    ) {
      throw new Error(`Invalid removal recovery record for ${id}.`);
    }
    removing[id] = { version: entry.version, tombstone: entry.tombstone };
  }
  return { version: 1, installed, removing };
}

function dependencyCapabilityIds(input: {
  readonly capability?: string;
  readonly capabilities?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return input.capabilities ?? (input.capability ? [input.capability] : []);
}

function selectedCapabilityIds(
  manifest: IntegrationManifest,
  installed: InstalledIntegrationState | undefined,
): ReadonlySet<string> {
  const known = new Set(manifest.capabilities.map(({ id }) => id));
  if (installed?.enabledCapabilities) {
    return new Set(installed.enabledCapabilities.filter((capability) => known.has(capability)));
  }

  const disabledCapabilities = new Set(
    manifest.skills
      .filter(({ name }) => installed?.disabledSkills?.includes(name))
      .flatMap(dependencyCapabilityIds),
  );
  return new Set(
    manifest.capabilities
      .filter(({ id, access }) => access !== "opt-in" && !disabledCapabilities.has(id))
      .map(({ id }) => id),
  );
}

const EMPTY_STATE: PersistedIntegrationState = {
  version: 1,
  installed: emptyRecord(),
  removing: emptyRecord(),
};

class ProviderStatusTimeoutError extends Error {
  constructor() {
    super("The integration provider timed out while reporting its status.");
    this.name = "ProviderStatusTimeoutError";
  }
}

class ProviderStatusContractError extends Error {
  constructor() {
    super("The integration provider returned an invalid status.");
    this.name = "ProviderStatusContractError";
  }
}

class ProviderOperationTimeoutError extends Error {
  constructor() {
    super("The integration provider operation timed out.");
    this.name = "ProviderOperationTimeoutError";
  }
}

class ProviderFaultedError extends Error {
  constructor() {
    super("The integration provider is faulted until its connection is reset.");
    this.name = "ProviderFaultedError";
  }
}

interface ProviderStatusAttempt {
  readonly controller: AbortController;
  readonly result: Promise<IntegrationProviderStatus>;
  timedOut: boolean;
}

interface ProviderCommitJournal {
  readonly version: 1;
  readonly integrationId: string;
  readonly providerId: string;
}

function validateProviderStatus(value: unknown): IntegrationProviderStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderStatusContractError();
  }
  const status = value as Record<string, unknown>;
  const accountLabel =
    typeof status.accountLabel === "string" ? status.accountLabel.trim() : status.accountLabel;
  const message = typeof status.message === "string" ? status.message.trim() : status.message;
  if (
    typeof status.state !== "string" ||
    !["not_connected", "connecting", "connected", "error"].includes(status.state) ||
    (accountLabel !== null && (typeof accountLabel !== "string" || accountLabel.length === 0)) ||
    !Array.isArray(status.grantedCapabilities) ||
    status.grantedCapabilities.some(
      (capability) => typeof capability !== "string" || capability.trim().length === 0,
    ) ||
    (message !== null && (typeof message !== "string" || message.length === 0))
  ) {
    throw new ProviderStatusContractError();
  }
  return {
    state: status.state as IntegrationProviderStatus["state"],
    accountLabel: accountLabel as string | null,
    grantedCapabilities: [
      ...new Set(
        (status.grantedCapabilities as Array<string>).map((capability) => capability.trim()),
      ),
    ],
    message: message as string | null,
  };
}

export function codexDynamicIntegrationToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/gu, "_");
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

function cancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Integration tool invocation was cancelled.");
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
      message: `Installed plugin version ${installedVersion} does not match included version ${manifest.version}. Restart Harness to reconcile it before activation.`,
    };
  }
  return manifestCompatibility(manifest);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const directory = NodePath.dirname(path);
  const directoryExisted = (await lstatOrNull(directory)) !== null;
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await NodeFSP.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temporary, path);
    await syncDirectory(directory);
    if (!directoryExisted) await syncDirectory(NodePath.dirname(directory));
  } catch (error) {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof NodeFSP.open>> | null = null;
  try {
    directory = await NodeFSP.open(path, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EISDIR" || code === "EINVAL" || code === "ENOTSUP" || code === "EPERM") {
      return;
    }
    throw error;
  } finally {
    await directory?.close();
  }
}

async function lstatOrNull(
  path: string,
): Promise<Awaited<ReturnType<typeof NodeFSP.lstat>> | null> {
  try {
    return await NodeFSP.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureManagedDirectory(path: string): Promise<void> {
  const entry = await lstatOrNull(path);
  if (entry?.isDirectory() && !entry.isSymbolicLink()) return;
  if (entry) await NodeFSP.unlink(path);
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  const created = await NodeFSP.lstat(path);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Managed integration path ${path} must be a real directory.`);
  }
}

async function readManagedDirectory(path: string) {
  const entry = await lstatOrNull(path);
  if (!entry) return [];
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Managed integration path ${path} must be a real directory.`);
  }
  return NodeFSP.readdir(path, { withFileTypes: true });
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
    const skillIsFile = await NodeFSP.stat(skillPath)
      .then((value) => value.isFile())
      .catch(() => false);
    if (!skillIsFile) {
      throw new Error(`Integration package is missing skills/${skill.name}/SKILL.md.`);
    }
    const skillContent = await NodeFSP.readFile(skillPath, "utf8");
    if (declaredIntegrationSkillName(skillContent) !== skill.name) {
      throw new Error(
        `Integration skill ${skill.name} must declare matching SKILL.md frontmatter.`,
      );
    }
  }
}

async function packageTreeDigest(root: string): Promise<string> {
  const rootEntry = await NodeFSP.lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error("The integration package root must be a real directory.");
  }
  const digest = NodeCrypto.createHash("sha256");
  const updateField = (value: string | Buffer): void => {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    digest.update(length);
    digest.update(bytes);
  };
  const visit = async (relativeDirectory: string): Promise<void> => {
    const directory = NodePath.join(root, relativeDirectory);
    const entries = (await NodeFSP.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relativePath = NodePath.join(relativeDirectory, entry.name);
      const path = NodePath.join(root, relativePath);
      if (entry.isSymbolicLink()) throw new Error("Integration packages cannot contain symlinks.");
      if (entry.isDirectory()) {
        digest.update(Buffer.from([0x01]));
        updateField(relativePath);
        await visit(relativePath);
      } else if (entry.isFile()) {
        digest.update(Buffer.from([0x02]));
        updateField(relativePath);
        updateField(await NodeFSP.readFile(path));
      } else {
        throw new Error("Integration packages can contain only files.");
      }
    }
  };
  await visit("");
  return digest.digest("hex");
}

export class RegistryRuntime {
  readonly #root: string;
  readonly #statePath: string;
  readonly #commitJournalRoot: string;
  readonly #catalog = new Map<string, IntegrationPackage>();
  #state: PersistedIntegrationState = EMPTY_STATE;
  #ready: Promise<void>;
  #stateMutation: Promise<void> = Promise.resolve();
  readonly #integrationOperations = new Map<string, Promise<void>>();
  readonly #summaries = new Map<string, IntegrationSummary>();
  readonly #summaryGenerations = new Map<string, number>();
  #availableTools = new Set<string>();
  #availabilityGeneration = 0;
  #availabilitySignature = JSON.stringify({ skills: [], tools: [] });
  readonly #availabilityObservers = new Set<(change: IntegrationAvailabilityChange) => void>();
  readonly #revocations = new Map<string, number>();
  readonly #capabilityRevocations = new Map<string, Map<string, number>>();
  readonly #activeInvocations = new Map<string, Set<AbortController>>();
  readonly #activeInvocationToolNames = new Map<AbortController, string>();
  readonly #activeInvocationGrantedCapabilities = new Map<AbortController, ReadonlySet<string>>();
  readonly #activeInvocationCompletionsByController = new Map<AbortController, Promise<void>>();
  readonly #activeSkillReservations = new Map<string, number>();
  readonly #skillReservationWaiters = new Map<string, Set<() => void>>();
  readonly #skills: IntegrationSkillMaterializer;
  readonly #removeInstalledPackage: (path: string) => Promise<void>;
  readonly #providerStatusTimeoutMs: number;
  readonly #providerOperationTimeoutMs: number;
  readonly #activeStatusChecks = new Set<AbortController>();
  readonly #activeStatusWork = new Set<Promise<IntegrationProviderStatus>>();
  readonly #providerStatusAttempts = new Map<IntegrationProvider, ProviderStatusAttempt>();
  readonly #faultedProviders = new Set<IntegrationProvider>();
  readonly #activeInvocationWork = new Set<Promise<unknown>>();
  readonly #activeInvocationCompletions = new Set<Promise<void>>();
  readonly #activeInvocationCompletionsByIntegration = new Map<string, Set<Promise<void>>>();
  readonly #closedProviders = new Set<IntegrationProvider>();
  readonly #providerCloseWork = new Map<IntegrationProvider, Promise<void>>();
  readonly #activeLifecycleControllers = new Set<AbortController>();
  readonly #committingLifecycleControllers = new Set<AbortController>();
  readonly #activeLifecycleWork = new Set<Promise<unknown>>();
  readonly #activeProviderLifecycleWork = new Map<IntegrationProvider, Set<Promise<unknown>>>();
  readonly #activeProviderCommitWork = new Map<IntegrationProvider, Set<Promise<unknown>>>();
  readonly #activeSummaryRefreshWork = new Set<Promise<void>>();
  readonly #skillSyncOperations = new Map<string, Promise<void>>();
  #closing = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    root: string,
    packages: ReadonlyArray<IntegrationPackage>,
    skills: IntegrationSkillMaterializer = noIntegrationSkills,
    removeInstalledPackage: (path: string) => Promise<void> = (path) =>
      NodeFSP.rm(path, { recursive: true, force: true }),
    options: RegistryRuntimeOptions = {},
  ) {
    this.#root = root;
    this.#statePath = NodePath.join(root, "state.json");
    this.#commitJournalRoot = NodePath.join(root, "commit-journal");
    this.#skills = skills;
    this.#removeInstalledPackage = removeInstalledPackage;
    this.#providerStatusTimeoutMs =
      options.providerStatusTimeoutMs ?? DEFAULT_PROVIDER_STATUS_TIMEOUT_MS;
    this.#providerOperationTimeoutMs =
      options.providerOperationTimeoutMs ?? DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#providerStatusTimeoutMs) ||
      this.#providerStatusTimeoutMs <= 0 ||
      !Number.isSafeInteger(this.#providerOperationTimeoutMs) ||
      this.#providerOperationTimeoutMs <= 0
    ) {
      throw new Error("Provider timeouts must be positive integers.");
    }
    for (const integration of packages) this.#register(integration);
    this.#ready = this.#load();
  }

  #register(integration: IntegrationPackage): void {
    if (this.#closing) throw new Error("Integration registry is closing.");
    const manifest = validateIntegrationManifest(integration.manifest);
    if (this.#catalog.has(manifest.id)) {
      throw new Error(`Integration ${manifest.id} is already registered.`);
    }
    if (integration.sourceRoot !== undefined && integration.bundledFiles !== undefined) {
      throw new Error(`Integration ${manifest.id} cannot declare two package sources.`);
    }
    if (manifest.provider === undefined && integration.provider !== undefined) {
      throw new Error(`Integration ${manifest.id} supplies an undeclared provider.`);
    }
    if (manifest.provider !== undefined && integration.provider === undefined) {
      throw new Error(
        `Integration ${manifest.id} declares provider ${manifest.provider} but none was supplied.`,
      );
    }
    if (manifest.provider !== undefined && manifest.provider !== integration.provider?.id) {
      throw new Error(
        `Manifest provider ${manifest.provider} does not match ${integration.provider?.id}.`,
      );
    }
    const provider = integration.provider;
    if (provider) {
      const hasConnect = typeof provider.connect === "function";
      const hasPoll = typeof provider.poll === "function";
      const hasDisconnect = typeof provider.disconnect === "function";
      if ((hasConnect || hasPoll || hasDisconnect) && (!hasConnect || !hasDisconnect)) {
        throw new Error(
          `Provider ${provider.id} must implement connect and disconnect together; polling is optional.`,
        );
      }
      if ([...this.#catalog.values()].some((entry) => entry.provider?.id === provider.id)) {
        throw new Error(`Integration provider ${provider.id} is already registered.`);
      }
    }
    const toolNames = new Set(manifest.tools.map(({ name }) => name));
    const skillNames = new Set(manifest.skills.map(({ name }) => name));
    const dynamicToolNames = new Map(
      manifest.tools.map(({ name }) => [codexDynamicIntegrationToolName(name), name] as const),
    );
    if (dynamicToolNames.size !== manifest.tools.length) {
      throw new Error("Integration " + manifest.id + " has colliding Codex function names.");
    }
    for (const registered of this.#catalog.values()) {
      const toolCollision = registered.manifest.tools.find(({ name }) => toolNames.has(name));
      if (toolCollision) {
        throw new Error(
          "Integration tool " +
            toolCollision.name +
            " is already declared by " +
            registered.manifest.id +
            ".",
        );
      }
      const skillCollision = registered.manifest.skills.find(({ name }) => skillNames.has(name));
      if (skillCollision) {
        throw new Error(
          "Integration skill " +
            skillCollision.name +
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
    const providerTools = integration.provider?.tools ?? [];
    const providerToolNames = new Set(providerTools.map(({ name }) => name));
    if (
      providerTools.length !== providerToolNames.size ||
      manifestToolNames.size !== providerToolNames.size ||
      [...manifestToolNames].some((name) => !providerToolNames.has(name))
    ) {
      throw new Error(
        `Provider ${integration.provider?.id ?? "none"} tool definitions do not match its manifest.`,
      );
    }
    for (const definition of providerTools) {
      const inputSchema = integrationToolJsonSchema(definition);
      const manifestTool = manifest.tools.find(({ name }) => name === definition.name)!;
      if (
        typeof definition.description !== "string" ||
        !definition.description.trim() ||
        typeof definition.readOnly !== "boolean" ||
        typeof definition.openWorld !== "boolean" ||
        (definition.destructive !== undefined && typeof definition.destructive !== "boolean") ||
        (definition.idempotent !== undefined && typeof definition.idempotent !== "boolean") ||
        inputSchema.type !== "object"
      ) {
        throw new Error(`Integration tool ${definition.name} has an invalid provider contract.`);
      }
      if ((manifestTool.effect !== "write") !== definition.readOnly) {
        throw new Error(
          `Integration tool ${definition.name} effect does not match its provider safety contract.`,
        );
      }
      for (const existing of this.#catalog.values()) {
        if (existing.provider?.tools.some(({ name }) => name === definition.name)) {
          throw new Error(`Integration tool ${definition.name} is already registered.`);
        }
      }
    }
    this.#catalog.set(manifest.id, {
      manifest,
      ...(integration.provider ? { provider: integration.provider } : {}),
      ...(integration.sourceRoot ? { sourceRoot: integration.sourceRoot } : {}),
      ...(integration.bundledFiles ? { bundledFiles: integration.bundledFiles } : {}),
    });
  }

  async #stagePackage(integration: IntegrationPackage, staging: string): Promise<void> {
    const { manifest, sourceRoot, bundledFiles } = integration;
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
  }

  async #reconcileInstalledCatalogPackages(): Promise<void> {
    const stagingRoot = NodePath.join(this.#root, ".staging");
    await NodeFSP.rm(stagingRoot, { recursive: true, force: true });
    for (const integration of this.#catalog.values()) {
      const { manifest } = integration;
      const installed = ownRecordValue(this.#state.installed, manifest.id);
      if (!installed || !manifestCompatibility(manifest).compatible) continue;

      const staging = NodePath.join(stagingRoot, `${manifest.id}.${crypto.randomUUID()}`);
      const installedRoot = NodePath.join(this.#root, "installed", manifest.id);
      try {
        await this.#stagePackage(integration, staging);
        const stagedDigest = await packageTreeDigest(staging);
        const safeInstalledVersion =
          installed.version.length > 0 &&
          NodePath.basename(installed.version) === installed.version;
        const installedVersionRoot = safeInstalledVersion
          ? NodePath.join(installedRoot, installed.version)
          : null;
        const installedRootEntry = await lstatOrNull(installedRoot);
        const installedRootIsSafe =
          installedRootEntry?.isDirectory() === true && !installedRootEntry.isSymbolicLink();
        const installedVersionEntry =
          installedRootIsSafe && installedVersionRoot
            ? await lstatOrNull(installedVersionRoot)
            : null;
        const installedVersionIsSafe =
          installedVersionEntry?.isDirectory() === true && !installedVersionEntry.isSymbolicLink();
        const installedDigest = installedVersionIsSafe
          ? await packageTreeDigest(installedVersionRoot!).catch(() => null)
          : null;
        const installedEntries = installedRootIsSafe
          ? await NodeFSP.readdir(installedRoot, { withFileTypes: true })
          : [];
        const cleanVersionTree =
          installedRootIsSafe &&
          installedEntries.length === 1 &&
          installedEntries[0]?.name === installed.version &&
          installedEntries[0].isDirectory() &&
          !installedEntries[0].isSymbolicLink();
        if (
          installed.version === manifest.version &&
          cleanVersionTree &&
          installedDigest === stagedDigest
        ) {
          continue;
        }

        const trashRoot = NodePath.join(this.#root, ".trash");
        const backup = NodePath.join(trashRoot, `${manifest.id}.reconcile.${crypto.randomUUID()}`);
        const target = NodePath.join(installedRoot, manifest.version);
        const installedRootExists = (await lstatOrNull(installedRoot)) !== null;
        let oldMoved = false;
        let replacementRootCreated = false;
        try {
          await NodeFSP.mkdir(trashRoot, { recursive: true, mode: 0o700 });
          if (installedRootExists) {
            await NodeFSP.rename(installedRoot, backup);
            oldMoved = true;
          }
          await NodeFSP.mkdir(installedRoot, { recursive: true, mode: 0o700 });
          replacementRootCreated = true;
          await NodeFSP.rename(staging, target);
          await this.#save({
            ...this.#state,
            installed: {
              ...this.#state.installed,
              [manifest.id]: { ...installed, version: manifest.version },
            },
          });
        } catch (error) {
          const rollbackFailures: Array<unknown> = [];
          if (replacementRootCreated) {
            await NodeFSP.rm(installedRoot, { recursive: true, force: true }).catch((failure) =>
              rollbackFailures.push(failure),
            );
          }
          if (oldMoved) {
            await NodeFSP.rename(backup, installedRoot).catch((failure) =>
              rollbackFailures.push(failure),
            );
          }
          if (rollbackFailures.length > 0) {
            throw new Error(
              `Integration package reconciliation failed and rollback was incomplete: ${safeMessage(rollbackFailures[0])}`,
              { cause: error },
            );
          }
          throw error;
        }
        await this.#removeInstalledPackage(backup).catch(() => undefined);
      } finally {
        await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    await NodeFSP.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  async #load(): Promise<void> {
    await ensureManagedDirectory(this.#root);
    await Promise.all(
      ["installed", ".trash", ".staging", "commit-journal"].map((name) =>
        ensureManagedDirectory(NodePath.join(this.#root, name)),
      ),
    );
    await NodeFSP.rm(NodePath.join(this.#root, "runtime-skills"), {
      recursive: true,
      force: true,
    });
    try {
      this.#state = decodePersistedState(
        JSON.parse(await NodeFSP.readFile(this.#statePath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let capabilityMigrationRequired = false;
    const migratedInstalled = copyOwnRecord(this.#state.installed);
    for (const { manifest } of this.#catalog.values()) {
      const installed = ownRecordValue(migratedInstalled, manifest.id);
      if (!installed || installed.enabledCapabilities !== undefined) continue;
      migratedInstalled[manifest.id] = {
        version: installed.version,
        enabled: installed.enabled,
        enabledCapabilities: [...selectedCapabilityIds(manifest, installed)].toSorted(),
      };
      capabilityMigrationRequired = true;
    }
    if (capabilityMigrationRequired) {
      await this.#save({ ...this.#state, installed: migratedInstalled });
    }
    await this.#reconcileRemovals();
    await this.#pruneOrphanedInstalledPackages();
    await this.#reconcileInstalledCatalogPackages();
    await this.#loadProviderCommitJournals();
    await this.#skills.reconcileCatalog(new Set(this.#catalog.keys()));
    const trashRoot = NodePath.join(this.#root, ".trash");
    try {
      await NodeFSP.access(trashRoot);
      await this.#removeInstalledPackage(trashRoot).catch(() => undefined);
    } catch {}
    await Promise.all(
      [...this.#catalog.values()].map((integration) => this.#summarize(integration)),
    );
  }

  #commitJournalPath(integrationId: string): string {
    return NodePath.join(this.#commitJournalRoot, `${integrationId}.json`);
  }

  async #writeProviderCommitJournal(integrationId: string, providerId: string): Promise<void> {
    await atomicJson(this.#commitJournalPath(integrationId), {
      version: 1,
      integrationId,
      providerId,
    } satisfies ProviderCommitJournal);
  }

  async #clearProviderCommitJournal(integrationId: string): Promise<void> {
    await NodeFSP.rm(this.#commitJournalPath(integrationId), { force: true });
    if ((await lstatOrNull(this.#commitJournalRoot)) !== null) {
      await syncDirectory(this.#commitJournalRoot);
    }
  }

  async #providerCommitJournalExists(integrationId: string): Promise<boolean> {
    return (await lstatOrNull(this.#commitJournalPath(integrationId))) !== null;
  }

  async #loadProviderCommitJournals(): Promise<void> {
    const entries = await NodeFSP.readdir(this.#commitJournalRoot, { withFileTypes: true }).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const path = NodePath.join(this.#commitJournalRoot, entry.name);
      if (entry.isFile() && entry.name.endsWith(".tmp")) {
        await NodeFSP.rm(path, { force: true });
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
        throw new Error("Integration provider commit journal contains an unsupported entry.");
      }
      const value = JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid provider commit journal ${entry.name}.`);
      }
      const journal = value as Record<string, unknown>;
      const integrationId = entry.name.slice(0, -".json".length);
      if (
        !hasOnlyKeys(journal, new Set(["version", "integrationId", "providerId"])) ||
        journal.version !== 1 ||
        journal.integrationId !== integrationId ||
        !isIntegrationId(integrationId) ||
        !isIntegrationId(journal.providerId)
      ) {
        throw new Error(`Invalid provider commit journal ${entry.name}.`);
      }
      const integration = this.#catalog.get(integrationId);
      if (!integration?.provider) continue;
      if (integration.provider.id !== journal.providerId) {
        throw new Error(`Provider commit journal ${entry.name} does not match the fixed catalog.`);
      }
      this.#faultedProviders.add(integration.provider);
    }
  }

  async #pruneOrphanedInstalledPackages(): Promise<void> {
    const installedRoot = NodePath.join(this.#root, "installed");
    const entries = await readManagedDirectory(installedRoot);
    for (const entry of entries) {
      if (hasOwnRecordKey(this.#state.installed, entry.name)) continue;
      const trashRoot = NodePath.join(this.#root, ".trash");
      const tombstone = NodePath.join(trashRoot, `${entry.name}.orphan.${crypto.randomUUID()}`);
      await NodeFSP.mkdir(trashRoot, { recursive: true, mode: 0o700 });
      await NodeFSP.rename(NodePath.join(installedRoot, entry.name), tombstone);
      await this.#removeInstalledPackage(tombstone).catch(() => undefined);
    }
  }

  async #reconcileRemovals(): Promise<void> {
    for (const [id, removal] of Object.entries(this.#state.removing ?? {})) {
      if (
        !isIntegrationId(id) ||
        !removal ||
        !isIntegrationVersion(removal.version) ||
        typeof removal.tombstone !== "string" ||
        NodePath.basename(removal.tombstone) !== removal.tombstone ||
        !removal.tombstone.startsWith(`${id}.`)
      ) {
        throw new Error(`Invalid removal recovery record for ${id}.`);
      }
      const installedRoot = NodePath.join(this.#root, "installed", id);
      const trashRoot = NodePath.join(this.#root, ".trash");
      const tombstone = NodePath.join(trashRoot, removal.tombstone);
      const installedExists = (await lstatOrNull(installedRoot)) !== null;
      const tombstoneExists = (await lstatOrNull(tombstone)) !== null;
      if (installedExists && tombstoneExists) {
        throw new Error(`Removal recovery found both installed and tombstoned copies for ${id}.`);
      }
      if (installedExists) {
        await NodeFSP.mkdir(trashRoot, { recursive: true, mode: 0o700 });
        await NodeFSP.rename(installedRoot, tombstone);
      }
      await this.#save({
        version: 1,
        installed: withoutOwnKey(this.#state.installed, id),
        removing: withoutOwnKey(this.#state.removing, id),
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
    if (this.#closing) {
      return Promise.reject(operationError("disabled", "Integration registry is closing."));
    }
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

  #syncSkills(input: IntegrationSkillSync): Promise<void> {
    const previous = this.#skillSyncOperations.get(input.integrationId) ?? Promise.resolve();
    const run = previous.then(() => this.#skills.sync(input));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#skillSyncOperations.set(input.integrationId, tail);
    void tail.then(() => {
      if (this.#skillSyncOperations.get(input.integrationId) === tail) {
        this.#skillSyncOperations.delete(input.integrationId);
      }
    });
    return run;
  }

  #skillKey(id: string, skill: string): string {
    return `${id}\0${skill}`;
  }

  #waitForSkillReservations(id: string, skill?: string): Promise<void> {
    const exact = skill === undefined ? null : this.#skillKey(id, skill);
    const prefix = `${id}\0`;
    const keys = [...this.#activeSkillReservations.keys()].filter((key) =>
      exact === null ? key.startsWith(prefix) : key === exact,
    );
    if (keys.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const pending = new Set(keys);
      const registered = new Map<string, () => void>();
      let settled = false;
      const cleanup = () => {
        for (const [key, waiter] of registered) {
          const waiters = this.#skillReservationWaiters.get(key);
          waiters?.delete(waiter);
          if (waiters?.size === 0) this.#skillReservationWaiters.delete(key);
        }
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          operationError(
            "operation_failed",
            `${this.#catalog.get(id)?.manifest.name ?? id} did not finish active skill submission before the revocation timeout.`,
          ),
        );
      }, this.#providerOperationTimeoutMs);
      for (const key of keys) {
        const waiter = () => {
          if (settled) return;
          pending.delete(key);
          if (pending.size > 0) return;
          settled = true;
          clearTimeout(timeout);
          cleanup();
          resolve();
        };
        registered.set(key, waiter);
        const waiters = this.#skillReservationWaiters.get(key) ?? new Set<() => void>();
        waiters.add(waiter);
        this.#skillReservationWaiters.set(key, waiters);
      }
    });
  }

  #beginRevocation(id: string): {
    readonly ready: Promise<void>;
    readonly finish: () => void;
  } {
    if (this.#catalog.has(id)) {
      this.#summaryGenerations.set(id, (this.#summaryGenerations.get(id) ?? 0) + 1);
    }
    this.#revocations.set(id, (this.#revocations.get(id) ?? 0) + 1);
    this.#publishAvailabilityChangeIfNeeded();
    for (const controller of this.#activeInvocations.get(id) ?? []) controller.abort();
    const invocationCompletions = [
      ...(this.#activeInvocationCompletionsByIntegration.get(id) ?? []),
    ];
    const invocationsReady =
      invocationCompletions.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              const integration = this.#catalog.get(id);
              const provider = integration?.provider;
              if (provider) this.#faultProvider(provider);
              reject(
                operationError(
                  "operation_failed",
                  `${integration?.manifest.name ?? id} did not stop active tool work before the revocation timeout.`,
                ),
              );
            }, this.#providerOperationTimeoutMs);
            void Promise.allSettled(invocationCompletions).then(() => {
              clearTimeout(timeout);
              resolve();
            });
          });
    return {
      ready: Promise.all([this.#waitForSkillReservations(id), invocationsReady]).then(
        () => undefined,
      ),
      finish: () => {
        const remaining = (this.#revocations.get(id) ?? 1) - 1;
        if (remaining > 0) this.#revocations.set(id, remaining);
        else this.#revocations.delete(id);
        this.#publishAvailabilityChangeIfNeeded();
      },
    };
  }

  #beginCapabilityRevocation(
    manifest: IntegrationManifest,
    installed: InstalledIntegrationState | undefined,
    capability: string,
  ): {
    readonly ready: Promise<void>;
    readonly finish: () => void;
  } {
    const remainingCapabilities = new Set(selectedCapabilityIds(manifest, installed));
    remainingCapabilities.delete(capability);
    const alreadyRevoking = this.#capabilityRevocations.get(manifest.id);
    for (const revokingCapability of alreadyRevoking?.keys() ?? []) {
      remainingCapabilities.delete(revokingCapability);
    }
    const effectivelyAvailableCapabilities = new Set(
      this.#summaries
        .get(manifest.id)
        ?.capabilities.filter(({ id, available }) => available && remainingCapabilities.has(id))
        .map(({ id }) => id) ?? [],
    );
    const affectedSkills = manifest.skills
      .filter((skill) => {
        const dependencies = dependencyCapabilityIds(skill);
        return (
          dependencies.includes(capability) &&
          !dependencies.some((dependency) => effectivelyAvailableCapabilities.has(dependency))
        );
      })
      .map(({ name }) => name);

    this.#summaryGenerations.set(manifest.id, (this.#summaryGenerations.get(manifest.id) ?? 0) + 1);
    const revoking = this.#capabilityRevocations.get(manifest.id) ?? new Map<string, number>();
    revoking.set(capability, (revoking.get(capability) ?? 0) + 1);
    this.#capabilityRevocations.set(manifest.id, revoking);
    this.#publishAvailabilityChangeIfNeeded();

    const abortedControllers = new Set<AbortController>();
    for (const controller of this.#activeInvocations.get(manifest.id) ?? []) {
      const toolName = this.#activeInvocationToolNames.get(controller);
      const tool = manifest.tools.find(({ name }) => name === toolName);
      if (!tool) continue;
      const dependencies = dependencyCapabilityIds(tool);
      if (!dependencies.includes(capability)) continue;
      const grantedCapabilities = this.#activeInvocationGrantedCapabilities.get(controller);
      const hasEffectiveAlternative = dependencies.some(
        (dependency) =>
          remainingCapabilities.has(dependency) &&
          (grantedCapabilities
            ? grantedCapabilities.has(dependency)
            : effectivelyAvailableCapabilities.has(dependency)),
      );
      if (hasEffectiveAlternative) continue;
      abortedControllers.add(controller);
      controller.abort();
    }
    const invocationCompletions = [...abortedControllers]
      .map((controller) => this.#activeInvocationCompletionsByController.get(controller))
      .filter((completion): completion is Promise<void> => completion !== undefined);
    const invocationsReady =
      invocationCompletions.length === 0
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              const provider = this.#catalog.get(manifest.id)?.provider;
              if (provider) this.#faultProvider(provider);
              reject(
                operationError(
                  "operation_failed",
                  `${manifest.name} did not stop affected tool work before the revocation timeout.`,
                ),
              );
            }, this.#providerOperationTimeoutMs);
            void Promise.allSettled(invocationCompletions).then(() => {
              clearTimeout(timeout);
              resolve();
            });
          });

    return {
      ready: Promise.all([
        ...affectedSkills.map((skill) => this.#waitForSkillReservations(manifest.id, skill)),
        invocationsReady,
      ]).then(() => undefined),
      finish: () => {
        const current = this.#capabilityRevocations.get(manifest.id);
        const remaining = (current?.get(capability) ?? 1) - 1;
        if (remaining > 0) current?.set(capability, remaining);
        else current?.delete(capability);
        if (current?.size === 0) this.#capabilityRevocations.delete(manifest.id);
        this.#publishAvailabilityChangeIfNeeded();
      },
    };
  }

  #isRevoking(id: string): boolean {
    return this.#revocations.has(id);
  }

  #isSurfaceRevoking(manifest: IntegrationManifest, dependencies: ReadonlyArray<string>): boolean {
    if (this.#isRevoking(manifest.id)) return true;
    const revoking = this.#capabilityRevocations.get(manifest.id);
    if (!revoking || revoking.size === 0) return false;
    return !dependencies.some(
      (capability) =>
        !revoking.has(capability) &&
        this.#summaries
          .get(manifest.id)
          ?.capabilities.some(({ id, available }) => id === capability && available) === true,
    );
  }

  async #save(state: PersistedIntegrationState): Promise<void> {
    const normalized: PersistedIntegrationState = {
      ...state,
      installed: copyOwnRecord(state.installed),
      removing: copyOwnRecord(state.removing),
    };
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

  #faultProvider(provider: IntegrationProvider): void {
    if (this.#faultedProviders.has(provider)) return;
    this.#faultedProviders.add(provider);
    for (const { manifest, provider: registeredProvider } of this.#catalog.values()) {
      if (registeredProvider !== provider) continue;
      this.#summaryGenerations.set(
        manifest.id,
        (this.#summaryGenerations.get(manifest.id) ?? 0) + 1,
      );
      for (const controller of this.#activeInvocations.get(manifest.id) ?? []) {
        controller.abort();
      }
      for (const { name } of manifest.tools) this.#availableTools.delete(name);
      const summary = this.#summaries.get(manifest.id);
      if (summary) {
        this.#summaries.set(manifest.id, {
          ...summary,
          connectionState: "error",
          accountLabel: null,
          statusMessage: "The integration provider is faulted. Reset its connection to recover.",
          capabilities: summary.capabilities.map((capability) => ({
            ...capability,
            granted: false,
            available: false,
          })),
          tools: summary.tools.map((tool) => ({ ...tool, available: false })),
          skills: summary.skills.map((skill) => ({ ...skill, available: false })),
        });
      }
      this.#publishAvailabilityChangeIfNeeded();
      const cleanup = this.#syncSkills({
        integrationId: manifest.id,
        packageRoot: null,
        activeSkills: [],
      });
      void cleanup.catch(() => undefined);
      return;
    }
  }

  #invalidateProviderStatus(provider: IntegrationProvider): void {
    const attempt = this.#providerStatusAttempts.get(provider);
    if (!attempt) return;
    this.#providerStatusAttempts.delete(provider);
  }

  async #providerStatus(
    provider: IntegrationProvider,
    parentSignal?: AbortSignal,
  ): Promise<IntegrationProviderStatus> {
    if (this.#closing) throw new Error("The integration provider status check was cancelled.");
    if (this.#faultedProviders.has(provider)) throw new ProviderFaultedError();
    const pending = this.#providerStatusAttempts.get(provider);
    if (pending) return this.#awaitProviderStatus(pending, parentSignal);

    const controller = new AbortController();
    this.#activeStatusChecks.add(controller);
    let timedOut = false;
    let removeAbortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        reject(
          timedOut
            ? new ProviderStatusTimeoutError()
            : new Error("The integration provider status check was cancelled."),
        );
      };
      if (controller.signal.aborted) onAbort();
      else {
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
      }
    });
    const statusWork = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted || this.#closing) {
          throw new Error("The integration provider status check was cancelled.");
        }
        return provider.status({ signal: controller.signal });
      })
      .then(validateProviderStatus);
    this.#activeStatusWork.add(statusWork);
    const attempt: ProviderStatusAttempt = {
      controller,
      result: Promise.race([statusWork, aborted]),
      timedOut: false,
    };
    this.#providerStatusAttempts.set(provider, attempt);
    const timeout = setTimeout(() => {
      timedOut = true;
      attempt.timedOut = true;
      controller.abort();
    }, this.#providerStatusTimeoutMs);
    const finish = () => {
      clearTimeout(timeout);
      removeAbortListener();
      this.#activeStatusChecks.delete(controller);
      this.#activeStatusWork.delete(statusWork);
      if (this.#providerStatusAttempts.get(provider) === attempt) {
        this.#providerStatusAttempts.delete(provider);
      }
    };
    void statusWork.then(finish, finish);
    void attempt.result.catch(() => undefined);
    return this.#awaitProviderStatus(attempt, parentSignal);
  }

  async #awaitProviderStatus(
    attempt: ProviderStatusAttempt,
    parentSignal?: AbortSignal,
  ): Promise<IntegrationProviderStatus> {
    if (attempt.timedOut) throw new ProviderStatusTimeoutError();
    if (!parentSignal) return attempt.result;
    if (parentSignal.aborted) {
      throw new Error("The integration provider status check was cancelled.");
    }
    let removeAbortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        reject(new Error("The integration provider status check was cancelled."));
      };
      parentSignal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => parentSignal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([attempt.result, aborted]);
    } finally {
      removeAbortListener();
    }
  }

  async #providerOperation<A>(
    provider: IntegrationProvider,
    operation: (context: IntegrationLifecycleContext) => Promise<A>,
    options: { readonly allowFaulted?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<A> {
    if (this.#closing) {
      throw new Error("The integration provider operation was cancelled.");
    }
    if (this.#faultedProviders.has(provider) && !options.allowFaulted) {
      throw new ProviderFaultedError();
    }
    if (this.#activeProviderLifecycleWork.has(provider)) {
      throw new Error("The integration provider operation is still settling.");
    }
    const integration = [...this.#catalog.values()].find(
      ({ provider: candidate }) => candidate === provider,
    );
    if (!integration) throw new Error("Integration provider is not registered.");
    this.#invalidateProviderStatus(provider);
    const controller = new AbortController();
    this.#activeLifecycleControllers.add(controller);
    let removeCallerAbortListener: () => void = () => undefined;
    if (options.signal) {
      const abortFromCaller = () => controller.abort(options.signal?.reason);
      if (options.signal.aborted) abortFromCaller();
      else {
        options.signal.addEventListener("abort", abortFromCaller, { once: true });
        removeCallerAbortListener = () =>
          options.signal?.removeEventListener("abort", abortFromCaller);
      }
    }
    let timedOut = false;
    let commitStarted = false;
    const commitController = new AbortController();
    let rejectOperation: (error: Error) => void = () => undefined;
    let commitAdmission: Promise<AbortSignal> | null = null;
    let preAdmissionCancelled = false;
    const operationDeadline = Date.now() + this.#providerOperationTimeoutMs;
    let timeout = setTimeout(
      () => {
        timedOut = true;
        if (!commitAdmission) this.#faultProvider(provider);
        controller.abort();
      },
      Math.max(0, operationDeadline - Date.now()),
    );
    let commitAbortTimeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
      const onAbort = () => {
        if (commitStarted) return;
        reject(
          timedOut
            ? new ProviderOperationTimeoutError()
            : new Error("The integration provider operation was cancelled."),
        );
      };
      if (controller.signal.aborted) onAbort();
      else {
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
      }
    });
    let work!: Promise<A>;
    work = Promise.resolve().then(() => {
      if (controller.signal.aborted || this.#closing) {
        throw new Error("The integration provider operation was cancelled.");
      }
      return operation({
        signal: controller.signal,
        beginCommit: () => {
          if (commitAdmission) return commitAdmission;
          if (controller.signal.aborted || this.#closing) {
            return Promise.reject(new Error("The integration provider operation was cancelled."));
          }
          commitAdmission = (async () => {
            const preserveJournal = await this.#providerCommitJournalExists(
              integration.manifest.id,
            );
            if (controller.signal.aborted || this.#closing) {
              preAdmissionCancelled = true;
              throw new Error("The integration provider operation was cancelled.");
            }
            try {
              await this.#writeProviderCommitJournal(integration.manifest.id, provider.id);
            } catch (error) {
              if (!controller.signal.aborted && !this.#closing) throw error;
              if (!preserveJournal) {
                try {
                  await this.#clearProviderCommitJournal(integration.manifest.id);
                } catch (cleanupError) {
                  this.#faultProvider(provider);
                  throw cleanupError;
                }
              }
              preAdmissionCancelled = true;
              throw new Error("The integration provider operation was cancelled.", {
                cause: error,
              });
            }
            if (controller.signal.aborted || this.#closing) {
              if (!preserveJournal) {
                try {
                  await this.#clearProviderCommitJournal(integration.manifest.id);
                } catch (error) {
                  this.#faultProvider(provider);
                  throw error;
                }
              }
              preAdmissionCancelled = true;
              throw new Error("The integration provider operation was cancelled.");
            }
            commitStarted = true;
            clearTimeout(timeout);
            this.#committingLifecycleControllers.add(controller);
            const commits = this.#activeProviderCommitWork.get(provider) ?? new Set();
            commits.add(work);
            this.#activeProviderCommitWork.set(provider, commits);
            void work.then(
              () => {
                commits.delete(work);
                if (commits.size === 0) this.#activeProviderCommitWork.delete(provider);
              },
              () => {
                commits.delete(work);
                if (commits.size === 0) this.#activeProviderCommitWork.delete(provider);
              },
            );
            const abortHeadroomMs = Math.min(
              250,
              Math.max(1, Math.floor(this.#providerOperationTimeoutMs / 10)),
            );
            commitAbortTimeout = setTimeout(
              () => commitController.abort(),
              Math.max(0, this.#providerOperationTimeoutMs - abortHeadroomMs),
            );
            timeout = setTimeout(() => {
              timedOut = true;
              this.#faultProvider(provider);
              rejectOperation(new ProviderOperationTimeoutError());
            }, this.#providerOperationTimeoutMs);
            return commitController.signal;
          })();
          return commitAdmission;
        },
      });
    });
    this.#activeLifecycleWork.add(work);
    const providerWork = this.#activeProviderLifecycleWork.get(provider) ?? new Set();
    providerWork.add(work);
    this.#activeProviderLifecycleWork.set(provider, providerWork);
    const finishWork = (): void => {
      clearTimeout(timeout);
      if (commitAbortTimeout) clearTimeout(commitAbortTimeout);
      this.#activeLifecycleWork.delete(work);
      providerWork.delete(work);
      if (providerWork.size === 0) this.#activeProviderLifecycleWork.delete(provider);
      this.#activeLifecycleControllers.delete(controller);
      this.#committingLifecycleControllers.delete(controller);
      this.#invalidateProviderStatus(provider);
    };
    void work.then(finishWork, finishWork);
    try {
      const result = await Promise.race([work, aborted]);
      if (commitAdmission) await commitAdmission;
      if (commitStarted) {
        clearTimeout(timeout);
        try {
          await this.#clearProviderCommitJournal(integration.manifest.id);
        } catch (error) {
          this.#faultProvider(provider);
          throw error;
        }
      }
      return result;
    } catch (error) {
      let commitAdmissionDrainTimedOut = false;
      if (commitAdmission) {
        try {
          await this.#waitForClosePhase(
            Promise.allSettled([commitAdmission, work]).then(() => undefined),
            operationDeadline,
          );
        } catch {
          commitAdmissionDrainTimedOut = true;
        }
      }
      // Success is the only generic proof that an admitted external commit settled. A provider
      // rejection may be ambiguous even when it returns promptly, so retain the durable journal
      // and require the verified disconnect/reset path to clear it.
      if (commitAdmission && (commitAdmissionDrainTimedOut || !preAdmissionCancelled)) {
        this.#faultProvider(provider);
      }
      throw error;
    } finally {
      removeAbortListener();
      removeCallerAbortListener();
    }
  }

  #refreshSummaryAfterProviderSettlement(
    integration: IntegrationPackage,
    provider: IntegrationProvider,
  ): void {
    const active = [...(this.#activeProviderLifecycleWork.get(provider) ?? [])];
    const refresh = Promise.allSettled(active)
      .then(async () => {
        if (!this.#closing) await this.#summarize(integration);
      })
      .catch(() => undefined);
    this.#activeSummaryRefreshWork.add(refresh);
    void refresh.then(() => this.#activeSummaryRefreshWork.delete(refresh));
  }

  #createSummary(
    manifest: IntegrationManifest,
    providerStatus: IntegrationProviderStatus,
    state: PersistedIntegrationState = this.#state,
  ): IntegrationSummary {
    const installed = ownRecordValue(state.installed, manifest.id);
    const enabled = installed?.enabled === true;
    const selectedCapabilities = selectedCapabilityIds(manifest, installed);
    const compatibility = activationCompatibility(manifest, installed?.version);
    const provider = this.#catalog.get(manifest.id)?.provider;
    const providerSettling = provider ? this.#activeProviderLifecycleWork.has(provider) : false;
    const available = (capability: string) =>
      Boolean(
        installed &&
        enabled &&
        selectedCapabilities.has(capability) &&
        compatibility.compatible &&
        !providerSettling &&
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
      requiresConnection: hasConnectionLifecycle(this.#catalog.get(manifest.id)?.provider),
      connectionState: providerStatus.state,
      accountLabel: providerStatus.accountLabel,
      statusMessage: providerStatus.message,
      capabilities: manifest.capabilities.map((capability) => ({
        id: capability.id,
        displayName: capability.displayName,
        description: capability.description,
        access: capability.access ?? "default",
        enabled: selectedCapabilities.has(capability.id),
        granted: providerStatus.grantedCapabilities.includes(capability.id),
        available: available(capability.id),
      })),
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        capabilities: dependencyCapabilityIds(tool),
        effect: tool.effect ?? "read",
        available: dependencyCapabilityIds(tool).some(available),
      })),
      skills: manifest.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        capabilities: dependencyCapabilityIds(skill),
        enabled: dependencyCapabilityIds(skill).some((capability) =>
          selectedCapabilities.has(capability),
        ),
        available: dependencyCapabilityIds(skill).some(available),
      })),
    };
  }

  async #summarize(
    { manifest, provider }: IntegrationPackage,
    strictSkillSync = false,
  ): Promise<IntegrationSummary> {
    const generation = (this.#summaryGenerations.get(manifest.id) ?? 0) + 1;
    this.#summaryGenerations.set(manifest.id, generation);
    const currentOrUnavailable = (): IntegrationSummary =>
      this.#summaries.get(manifest.id) ??
      this.#createSummary(manifest, {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      });
    const installed = ownRecordValue(this.#state.installed, manifest.id);
    const compatibility = activationCompatibility(manifest, installed?.version);
    let providerStatus: IntegrationProviderStatus = {
      state: "not_connected",
      accountLabel: null,
      grantedCapabilities: [],
      message: null,
    };
    if (installed && compatibility.compatible) {
      if (provider) {
        try {
          providerStatus = await this.#providerStatus(provider);
        } catch (error) {
          providerStatus = {
            state: "error",
            accountLabel: null,
            grantedCapabilities: [],
            message:
              error instanceof ProviderStatusTimeoutError || error instanceof ProviderFaultedError
                ? error.message
                : "The integration provider could not report its status.",
          };
        }
      } else {
        providerStatus = {
          state: "connected",
          accountLabel: null,
          grantedCapabilities: manifest.capabilities.map(({ id }) => id),
          message: "No connection required.",
        };
      }
    }
    if (this.#summaryGenerations.get(manifest.id) !== generation) {
      return currentOrUnavailable();
    }
    let integration = this.#createSummary(manifest, providerStatus);
    try {
      await this.#syncSkills({
        integrationId: integration.id,
        packageRoot: installed
          ? NodePath.join(this.#root, "installed", integration.id, installed.version)
          : null,
        activeSkills: integration.skills
          .filter(({ available }) => available)
          .map(({ name }) => name),
      });
    } catch (error) {
      if (this.#summaryGenerations.get(manifest.id) !== generation) {
        return currentOrUnavailable();
      }
      if (strictSkillSync) throw error;
      await this.#syncSkills({
        integrationId: integration.id,
        packageRoot: null,
        activeSkills: [],
      }).catch(() => undefined);
      const skillMessage = `Bundled skills could not be activated: ${safeMessage(error)}`;
      integration = {
        ...integration,
        statusMessage: integration.statusMessage
          ? `${integration.statusMessage} ${skillMessage}`
          : skillMessage,
        skills: integration.skills.map((skill) => ({ ...skill, available: false })),
      };
    }
    if (this.#summaryGenerations.get(manifest.id) !== generation) {
      return currentOrUnavailable();
    }
    const integrationToolNames = new Set(manifest.tools.map(({ name }) => name));
    this.#availableTools = new Set(
      [...this.#availableTools].filter((name) => !integrationToolNames.has(name)),
    );
    for (const tool of integration.tools) {
      if (tool.available) this.#availableTools.add(tool.name);
    }
    this.#summaries.set(manifest.id, integration);
    this.#publishAvailabilityChangeIfNeeded();
    return integration;
  }

  #publishAvailabilityChangeIfNeeded(): void {
    if (this.#closing) return;
    const availability = {
      skills: this.getAvailableSkillsSync()
        .map(({ name }) => name)
        .toSorted(),
      tools: this.getAvailableToolDefinitionsSync()
        .map(({ name }) => name)
        .toSorted(),
    };
    const signature = JSON.stringify(availability);
    if (signature === this.#availabilitySignature) return;
    this.#availabilitySignature = signature;
    this.#availabilityGeneration += 1;
    const change = { generation: this.#availabilityGeneration, ...availability };
    for (const observer of this.#availabilityObservers) {
      try {
        observer(change);
      } catch {
        // Availability notification is observational. A broken Harness consumer must never roll
        // back a completed integration mutation or weaken the registry's fail-closed checks.
      }
    }
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
        const capabilityRevocations = this.#capabilityRevocations.get(manifest.id);
        if (capabilityRevocations?.size) {
          const capabilityAvailable = (capability: string) =>
            !capabilityRevocations?.has(capability) &&
            summary.capabilities.some(({ id, available }) => id === capability && available);
          return {
            ...summary,
            capabilities: summary.capabilities.map((capability) => ({
              ...capability,
              available: capabilityAvailable(capability.id),
            })),
            tools: summary.tools.map((tool) => {
              const declared = manifest.tools.find(({ name }) => name === tool.name);
              return {
                ...tool,
                available:
                  tool.available &&
                  Boolean(declared && dependencyCapabilityIds(declared).some(capabilityAvailable)),
              };
            }),
            skills: summary.skills.map((skill) => {
              const declared = manifest.skills.find(({ name }) => name === skill.name);
              return {
                ...skill,
                available:
                  skill.available &&
                  Boolean(declared && dependencyCapabilityIds(declared).some(capabilityAvailable)),
              };
            }),
          };
        }
        const installed = ownRecordValue(state.installed, manifest.id);
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
    if (this.#closing) throw operationError("disabled", "Integration registry is closing.");
    await this.#ready;
    if (this.#closing) throw operationError("disabled", "Integration registry is closing.");
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

  async snapshot(): Promise<IntegrationsListResult> {
    if (this.#closing) throw operationError("disabled", "Integration registry is closing.");
    await this.#ready;
    if (this.#closing) throw operationError("disabled", "Integration registry is closing.");
    return this.#cachedList();
  }

  get availabilityGeneration(): number {
    return this.#availabilityGeneration;
  }

  subscribeAvailabilityChanges(
    observer: (change: IntegrationAvailabilityChange) => void,
  ): () => void {
    if (this.#closing) return () => undefined;
    this.#availabilityObservers.add(observer);
    return () => this.#availabilityObservers.delete(observer);
  }

  isToolAvailableSync(name: string): boolean {
    if (this.#closing) return false;
    if (!this.#availableTools.has(name)) return false;
    for (const { manifest, provider } of this.#catalog.values()) {
      const tool = manifest.tools.find((candidate) => candidate.name === name);
      if (tool) {
        return (
          !this.#isSurfaceRevoking(manifest, dependencyCapabilityIds(tool)) &&
          !(
            provider &&
            (this.#faultedProviders.has(provider) ||
              this.#activeProviderLifecycleWork.has(provider))
          )
        );
      }
    }
    return false;
  }

  isSkillAvailableSync(name: string): boolean {
    if (this.#closing) return false;
    for (const { manifest, provider } of this.#catalog.values()) {
      const declaredSkill = manifest.skills.find((skill) => skill.name === name);
      if (!declaredSkill) continue;
      if (
        provider &&
        (this.#faultedProviders.has(provider) || this.#activeProviderLifecycleWork.has(provider))
      )
        return false;
      if (this.#isSurfaceRevoking(manifest, dependencyCapabilityIds(declaredSkill))) return false;
      return (
        this.#summaries
          .get(manifest.id)
          ?.skills.some((skill) => skill.name === name && skill.available) === true
      );
    }
    return false;
  }

  reserveSkillsSync(names: ReadonlyArray<string>): IntegrationSkillReservation | null {
    const reservationKeys = new Set<string>();
    for (const name of new Set(names)) {
      const integration = [...this.#catalog.values()].find(({ manifest }) =>
        manifest.skills.some((skill) => skill.name === name),
      );
      if (!integration || !this.isSkillAvailableSync(name)) return null;
      reservationKeys.add(this.#skillKey(integration.manifest.id, name));
    }
    for (const key of reservationKeys) {
      this.#activeSkillReservations.set(key, (this.#activeSkillReservations.get(key) ?? 0) + 1);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        for (const key of reservationKeys) {
          const remaining = (this.#activeSkillReservations.get(key) ?? 1) - 1;
          if (remaining > 0) {
            this.#activeSkillReservations.set(key, remaining);
            continue;
          }
          this.#activeSkillReservations.delete(key);
          const waiters = this.#skillReservationWaiters.get(key);
          this.#skillReservationWaiters.delete(key);
          for (const resolve of waiters ?? []) resolve();
        }
      },
    };
  }

  toolDefinitions(): ReadonlyArray<IntegrationProviderTool> {
    return [...this.#catalog.values()].flatMap(({ provider }) => provider?.tools ?? []);
  }

  getAvailableToolDefinitionsSync(): ReadonlyArray<IntegrationProviderTool> {
    return this.toolDefinitions().filter(({ name }) => this.isToolAvailableSync(name));
  }

  toolRequiresApprovalSync(name: string): boolean {
    return [...this.#catalog.values()].some(({ manifest }) =>
      manifest.tools.some((tool) => tool.name === name && tool.effect === "write"),
    );
  }

  getAvailableSkillsSync(): ReadonlyArray<IntegrationRuntimeSkill> {
    if (this.#closing) return [];
    return [...this.#catalog.values()].flatMap(({ manifest, provider }) => {
      if (provider && this.#faultedProviders.has(provider)) return [];
      const installed = ownRecordValue(this.#state.installed, manifest.id);
      const summary = this.#summaries.get(manifest.id);
      if (!installed || !summary) return [];
      return summary.skills
        .filter(({ name, available }) => available && this.isSkillAvailableSync(name))
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
    if (this.#closing) throw operationError("disabled", "Integration registry is closing.");
    await this.#ready;
    if (this.#closing) throw operationError("disabled", "Integration registry is closing.");
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
        await NodeFSP.cp(source, NodePath.join(staging, skill.name, skill.name), {
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
        root: NodePath.join(runtimeRoot, skill.name),
        path: NodePath.join(runtimeRoot, skill.name, skill.name, "SKILL.md"),
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
      const { manifest } = integration;
      const installed = ownRecordValue(this.#state.installed, id);
      const compatibility = activationCompatibility(manifest, installed?.version);
      if (!compatibility.compatible) throw operationError("incompatible", compatibility.message!);
      if (installed) {
        await this.#summarize(integration);
        return;
      }
      const versionRoot = NodePath.join(this.#root, "installed", id, manifest.version);
      const staging = `${versionRoot}.${crypto.randomUUID()}.staging`;
      try {
        await this.#stagePackage(integration, staging);
        await NodeFSP.mkdir(NodePath.dirname(versionRoot), { recursive: true, mode: 0o700 });
        await NodeFSP.rename(staging, versionRoot);
        await this.#updateState((state) => ({
          ...state,
          installed: {
            ...state.installed,
            [id]: {
              version: manifest.version,
              enabled: true,
              enabledCapabilities: [...selectedCapabilityIds(manifest, undefined)].toSorted(),
            },
          },
        }));
        await this.#summarize(integration, true);
      } catch (error) {
        await this.#updateState((state) => {
          const nextInstalled = { ...state.installed };
          delete nextInstalled[id];
          return { ...state, installed: nextInstalled };
        }).catch(() => undefined);
        await this.#syncSkills({ integrationId: id, packageRoot: null, activeSkills: [] }).catch(
          () => undefined,
        );
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
    const revocation = enabled ? null : this.#beginRevocation(id);
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      await revocation?.ready;
      const integration = this.#package(id);
      const { manifest, provider } = integration;
      const installed = ownRecordValue(this.#state.installed, id);
      if (!installed) throw operationError("not_installed", `Integration ${id} is not installed.`);
      const compatibility = activationCompatibility(manifest, installed.version);
      if (enabled && !compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      try {
        if (!enabled) {
          await this.#syncSkills({ integrationId: id, packageRoot: null, activeSkills: [] });
          if (provider && !hasConnectionLifecycle(provider)) {
            this.#faultedProviders.delete(provider);
          }
        }
        await this.#updateState((state) => ({
          ...state,
          installed: { ...state.installed, [id]: { ...installed, enabled } },
        }));
        await this.#summarize(integration, enabled);
      } catch (error) {
        let rollbackFailure: unknown;
        try {
          await this.#updateState((state) => ({
            ...state,
            installed: { ...state.installed, [id]: installed },
          }));
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
        }
        await this.#summarize(integration).catch(() => undefined);
        if (rollbackFailure !== undefined) {
          throw operationError(
            "operation_failed",
            `Enablement change failed and its rollback could not be persisted: ${safeMessage(error)} Rollback failure: ${safeMessage(rollbackFailure)}`,
          );
        }
        throw operationError(
          "operation_failed",
          `Enablement change was rolled back: ${safeMessage(error)}`,
        );
      }
    });
    const result = operation.then(() => this.#cachedList());
    return revocation ? result.finally(revocation.finish) : result;
  }

  setCapabilityEnabled(
    id: string,
    capability: string,
    enabled: boolean,
  ): Promise<IntegrationsListResult> {
    const registered = this.#catalog.get(id);
    if (!registered) {
      return Promise.reject(operationError("not_found", `Integration ${id} was not found.`));
    }
    if (!registered.manifest.capabilities.some(({ id }) => id === capability)) {
      return Promise.reject(
        operationError("not_found", `Integration capability ${capability} was not found in ${id}.`),
      );
    }
    const installedForRevocation = ownRecordValue(this.#state.installed, id);
    const revocation = !enabled
      ? this.#beginCapabilityRevocation(registered.manifest, installedForRevocation, capability)
      : null;
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      const integration = this.#package(id);
      const { manifest } = integration;
      const installed = ownRecordValue(this.#state.installed, id);
      if (!installed) throw operationError("not_installed", `Integration ${id} is not installed.`);
      if (!manifest.capabilities.some(({ id }) => id === capability)) {
        throw operationError(
          "not_found",
          `Integration capability ${capability} was not found in ${id}.`,
        );
      }
      const compatibility = activationCompatibility(manifest, installed.version);
      if (enabled && !compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      await revocation?.ready;
      const enabledCapabilities = new Set(selectedCapabilityIds(manifest, installed));
      if (enabled) enabledCapabilities.add(capability);
      else enabledCapabilities.delete(capability);
      const next: InstalledIntegrationState = {
        version: installed.version,
        enabled: installed.enabled,
        enabledCapabilities: [...enabledCapabilities].toSorted(),
      };
      try {
        await this.#updateState((state) => ({
          ...state,
          installed: { ...state.installed, [id]: next },
        }));
        await this.#summarize(integration, true);
      } catch (error) {
        let rollbackFailure: unknown;
        try {
          await this.#updateState((state) => ({
            ...state,
            installed: { ...state.installed, [id]: installed },
          }));
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
        }
        await this.#summarize(integration).catch(() => undefined);
        if (rollbackFailure !== undefined) {
          throw operationError(
            "operation_failed",
            `Capability access change failed and its rollback could not be persisted: ${safeMessage(error)} Rollback failure: ${safeMessage(rollbackFailure)}`,
          );
        }
        throw operationError(
          "operation_failed",
          `Capability access change was rolled back: ${safeMessage(error)}`,
        );
      }
    });
    const result = operation.then(() => this.#cachedList());
    return revocation ? result.finally(revocation.finish) : result;
  }

  /** Compatibility for pre-capability callers; the referenced Access bundle remains authoritative. */
  async setSkillEnabled(
    id: string,
    skillName: string,
    enabled: boolean,
  ): Promise<IntegrationsListResult> {
    const { manifest } = this.#package(id);
    const skill = manifest.skills.find(({ name }) => name === skillName);
    if (!skill) {
      throw operationError("not_found", `Integration skill ${skillName} was not found in ${id}.`);
    }
    const capabilities = dependencyCapabilityIds(skill);
    if (capabilities.length !== 1) {
      throw operationError(
        "operation_failed",
        `Integration skill ${skillName} is controlled by multiple Access abilities.`,
      );
    }
    return this.setCapabilityEnabled(id, capabilities[0]!, enabled);
  }

  connect(
    id: string,
    submission?: IntegrationConnectionSubmission,
    context?: IntegrationInvocationContext,
  ): Promise<IntegrationConnectResult> {
    const revocation = this.#beginRevocation(id);
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      await revocation.ready;
      const { manifest, provider } = this.#package(id);
      const installed = ownRecordValue(this.#state.installed, id);
      if (!installed) throw operationError("not_installed", `Integration ${id} is not installed.`);
      const compatibility = activationCompatibility(manifest, installed.version);
      if (!compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      if (!installed.enabled) {
        throw operationError("disabled", `Enable ${manifest.name} before connecting.`);
      }
      if (!hasConnectionLifecycle(provider)) {
        throw operationError("operation_failed", `${manifest.name} does not require a connection.`);
      }
      // Provider authorization follows the user's selected Harness abilities. Additive scopes in
      // an existing token remain inert unless their capability is selected here.
      const selectedCapabilities = selectedCapabilityIds(manifest, installed);
      const capabilities = manifest.capabilities
        .map(({ id: capability }) => capability)
        .filter((capability) => selectedCapabilities.has(capability));
      try {
        const result = await this.#providerOperation<IntegrationConnectResult>(
          provider,
          async (providerContext) => {
            const decoded = await decodeProviderConnectResult(
              await provider.connect(capabilities, providerContext, submission),
              {
                onExcessProperty: "error",
              },
            );
            if (decoded.kind === "device_code" && !hasPollingLifecycle(provider)) {
              throw new Error(
                `Provider ${provider.id} returned a device-code flow without implementing poll.`,
              );
            }
            return decoded;
          },
          context ? { signal: context.signal } : {},
        );
        await this.#summarize(this.#package(id));
        return result;
      } catch (error) {
        if (this.#activeProviderLifecycleWork.has(provider)) {
          this.#refreshSummaryAfterProviderSettlement(this.#package(id), provider);
        } else {
          await this.#summarize(this.#package(id)).catch(() => undefined);
        }
        throw operationError(
          "operation_failed",
          providerPublicMessage(
            error,
            `${manifest.name} authorization could not start. Try again.`,
          ),
        );
      }
    });
    return operation.finally(revocation.finish);
  }

  poll(
    id: string,
    flowId: string,
    context?: IntegrationInvocationContext,
  ): Promise<IntegrationPollResult> {
    const revocation = this.#beginRevocation(id);
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      await revocation.ready;
      const { manifest, provider } = this.#package(id);
      const installed = ownRecordValue(this.#state.installed, id);
      if (!installed) throw operationError("not_installed", `Integration ${id} is not installed.`);
      const compatibility = activationCompatibility(manifest, installed.version);
      if (!compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      if (!installed.enabled) {
        throw operationError("disabled", `${manifest.name} is disabled.`);
      }
      if (!hasPollingLifecycle(provider)) {
        throw operationError("operation_failed", `${manifest.name} does not support polling.`);
      }
      try {
        const result = await this.#providerOperation<IntegrationProviderPollResultType>(
          provider,
          async (providerContext) =>
            decodeProviderPollResult(await provider.poll(flowId, providerContext), {
              onExcessProperty: "error",
            }),
          context ? { signal: context.signal } : {},
        );
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
    return operation.finally(revocation.finish);
  }

  disconnect(id: string, context?: IntegrationInvocationContext): Promise<IntegrationsListResult> {
    const revocation = this.#beginRevocation(id);
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      await revocation.ready;
      const integration = this.#package(id);
      const { manifest, provider } = integration;
      if (!ownRecordValue(this.#state.installed, id))
        throw operationError("not_installed", `Integration ${id} is not installed.`);
      if (!hasConnectionLifecycle(provider)) {
        throw operationError("operation_failed", `${manifest.name} does not have a connection.`);
      }
      try {
        await this.#syncSkills({ integrationId: id, packageRoot: null, activeSkills: [] });
        await this.#providerOperation(
          provider,
          (providerContext) => provider.disconnect(providerContext),
          {
            allowFaulted: true,
            ...(context ? { signal: context.signal } : {}),
          },
        );
        await this.#clearProviderCommitJournal(id);
        this.#faultedProviders.delete(provider);
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
    return operation.then(() => this.#cachedList()).finally(revocation.finish);
  }

  remove(id: string): Promise<IntegrationsListResult> {
    const revocation = this.#beginRevocation(id);
    const operation = this.#serializeIntegration(id, async () => {
      await this.#ready;
      await revocation.ready;
      const integration = this.#package(id);
      const { manifest, provider } = integration;
      const installed = ownRecordValue(this.#state.installed, id);
      if (!installed) {
        await this.#summarize(integration);
        return;
      }
      try {
        await this.#syncSkills({ integrationId: id, packageRoot: null, activeSkills: [] });
        if (hasConnectionLifecycle(provider)) {
          await this.#providerOperation(provider, (context) => provider.disconnect(context), {
            allowFaulted: true,
          });
          await this.#clearProviderCommitJournal(id);
          this.#faultedProviders.delete(provider);
        } else if (provider) {
          this.#faultedProviders.delete(provider);
        }
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
      const previousRemoval = ownRecordValue(this.#state.removing, id);
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
    return operation.then(() => this.#cachedList()).finally(revocation.finish);
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closing = true;
      const closing = this.#closeRuntime();
      this.#closePromise = closing;
      void closing.then(
        () => undefined,
        () => {
          if (this.#closePromise === closing) this.#closePromise = null;
        },
      );
    }
    return this.#closePromise;
  }

  async #waitForClosePhase(work: Promise<unknown>, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Integration registry work did not drain before the close timeout.");
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("Integration registry work did not drain before the close timeout."),
              ),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async #drainCloseWork(deadline: number): Promise<void> {
    await this.#waitForClosePhase(
      this.#ready.catch(() => undefined),
      deadline,
    );
    while (
      this.#integrationOperations.size > 0 ||
      this.#activeStatusWork.size > 0 ||
      this.#activeLifecycleWork.size > 0 ||
      this.#activeSummaryRefreshWork.size > 0 ||
      this.#activeInvocationWork.size > 0 ||
      this.#activeInvocationCompletions.size > 0 ||
      this.#skillSyncOperations.size > 0
    ) {
      const work = new Set<Promise<unknown>>([
        ...this.#integrationOperations.values(),
        ...this.#activeStatusWork,
        ...this.#activeLifecycleWork,
        ...this.#activeSummaryRefreshWork,
        ...this.#activeInvocationWork,
        ...this.#activeInvocationCompletions,
        ...this.#skillSyncOperations.values(),
      ]);
      await this.#waitForClosePhase(
        Promise.allSettled(work).then(() => undefined),
        deadline,
      );
      await Promise.resolve();
    }
    await this.#waitForClosePhase(this.#stateMutation, deadline);
  }

  async #drainProviderCommitWork(deadline: number): Promise<void> {
    while (this.#activeProviderCommitWork.size > 0) {
      const work = new Set(
        [...this.#activeProviderCommitWork.values()].flatMap((commits) => [...commits]),
      );
      await this.#waitForClosePhase(
        Promise.allSettled(work).then(() => undefined),
        deadline,
      );
      await Promise.resolve();
    }
  }

  async #closeProviders(deadline: number): Promise<void> {
    const providers = new Set(
      [...this.#catalog.values()].flatMap(({ provider }) =>
        provider &&
        !this.#closedProviders.has(provider) &&
        !this.#activeProviderCommitWork.has(provider)
          ? [provider]
          : [],
      ),
    );
    const results = Promise.allSettled(
      [...providers].map((provider) => {
        const existing = this.#providerCloseWork.get(provider);
        if (existing) return existing;
        const work = Promise.resolve()
          .then(() => provider.close?.())
          .then(() => {
            this.#closedProviders.add(provider);
          });
        this.#providerCloseWork.set(provider, work);
        void work.then(
          () => this.#providerCloseWork.delete(provider),
          () => this.#providerCloseWork.delete(provider),
        );
        return work;
      }),
    );
    await this.#waitForClosePhase(
      results.then(() => undefined),
      deadline,
    );
    const failure = (await results).find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  async #closeRuntime(): Promise<void> {
    for (const controller of this.#activeStatusChecks) controller.abort();
    for (const controller of this.#activeLifecycleControllers) {
      if (!this.#committingLifecycleControllers.has(controller)) controller.abort();
    }
    for (const controllers of this.#activeInvocations.values()) {
      for (const controller of controllers) controller.abort();
    }
    const deadline = Date.now() + this.#providerOperationTimeoutMs + this.#providerStatusTimeoutMs;
    const closeDeadline = () => Math.min(deadline, Date.now() + this.#providerStatusTimeoutMs);
    // Provider close is the cancellation backstop for work that cannot make progress from its
    // AbortSignal alone. Admitted commit work is excluded by #closeProviders until it settles.
    let closeFailure: unknown;
    try {
      await this.#closeProviders(closeDeadline());
    } catch (error) {
      closeFailure = error;
    }

    // Wait only on admitted commits before the second close pass. Mixing these promises with an
    // abort-ignoring invocation would deadlock because provider.close is its cancellation backstop.
    await this.#drainProviderCommitWork(deadline);
    try {
      await this.#closeProviders(closeDeadline());
    } catch (error) {
      closeFailure ??= error;
    }

    await this.#drainCloseWork(deadline);
    if (closeFailure !== undefined) throw closeFailure;
  }

  async invokeTool(
    name: string,
    input: unknown,
    context?: IntegrationInvocationContext,
  ): Promise<unknown> {
    if (this.#closing) throw operationError("disabled", "Integration registry is closing.");
    await this.#ready;
    if (this.#closing) throw operationError("disabled", "Integration registry is closing.");
    if (context?.signal.aborted) throw cancellationError(context.signal);
    for (const { manifest, provider } of this.#catalog.values()) {
      const tool = manifest.tools.find((candidate) => candidate.name === name);
      if (!tool) continue;
      if (!provider) {
        throw operationError("not_found", `Integration tool ${name} has no provider.`);
      }
      if (this.#faultedProviders.has(provider)) {
        throw operationError(
          "operation_failed",
          `${manifest.name} is unavailable until its connection is reset.`,
        );
      }
      if (this.#activeProviderLifecycleWork.has(provider)) {
        throw operationError(
          "operation_failed",
          `${manifest.name} is unavailable while its connection is changing.`,
        );
      }
      const toolCapabilities = dependencyCapabilityIds(tool);
      if (this.#isSurfaceRevoking(manifest, toolCapabilities)) {
        throw operationError("disabled", `${manifest.name} access is being revoked.`);
      }
      const installed = ownRecordValue(this.#state.installed, manifest.id);
      if (!installed?.enabled) {
        throw operationError("disabled", `${manifest.name} is not enabled.`);
      }
      if (tool.effect === "write" && context?.writeApproved !== true) {
        throw operationError(
          "operation_failed",
          `${tool.displayName} requires Harness confirmation before it can run.`,
        );
      }
      const compatibility = activationCompatibility(manifest, installed.version);
      if (!compatibility.compatible) {
        throw operationError("incompatible", compatibility.message!);
      }
      const controller = new AbortController();
      const signal = context
        ? AbortSignal.any([controller.signal, context.signal])
        : controller.signal;
      let finishInvocation!: () => void;
      const invocationCompletion = new Promise<void>((resolve) => {
        finishInvocation = resolve;
      });
      this.#activeInvocationCompletions.add(invocationCompletion);
      this.#activeInvocationCompletionsByController.set(controller, invocationCompletion);
      const integrationCompletions =
        this.#activeInvocationCompletionsByIntegration.get(manifest.id) ?? new Set<Promise<void>>();
      integrationCompletions.add(invocationCompletion);
      this.#activeInvocationCompletionsByIntegration.set(manifest.id, integrationCompletions);
      const active = this.#activeInvocations.get(manifest.id) ?? new Set<AbortController>();
      active.add(controller);
      this.#activeInvocationToolNames.set(controller, name);
      this.#activeInvocations.set(manifest.id, active);
      try {
        const status = await this.#providerStatus(provider, signal);
        this.#activeInvocationGrantedCapabilities.set(
          controller,
          new Set(status.grantedCapabilities),
        );
        if (controller.signal.aborted || this.#isSurfaceRevoking(manifest, toolCapabilities)) {
          throw operationError("disabled", `${manifest.name} access is being revoked.`);
        }
        if (context?.signal.aborted) throw cancellationError(context.signal);
        if (status.state !== "connected") {
          throw operationError("not_connected", `${manifest.name} is not connected.`);
        }
        const currentInstalled = ownRecordValue(this.#state.installed, manifest.id);
        if (!currentInstalled?.enabled) {
          throw operationError("disabled", `${manifest.name} is not enabled.`);
        }
        const selectedCapabilities = selectedCapabilityIds(manifest, currentInstalled);
        const authorizedCapability = toolCapabilities.find(
          (capability) =>
            selectedCapabilities.has(capability) &&
            !this.#capabilityRevocations.get(manifest.id)?.has(capability) &&
            status.grantedCapabilities.includes(capability),
        );
        if (!authorizedCapability) {
          throw operationError(
            "capability_required",
            `${tool.displayName} requires enabled access to ${toolCapabilities.join(" or ")}.`,
          );
        }
        const definition = provider.tools.find((candidate) => candidate.name === name);
        if (!definition) {
          throw operationError("not_found", `Integration tool ${name} has no definition.`);
        }
        let decodedInput: unknown;
        try {
          decodedInput = await decodeIntegrationToolInput(definition, input);
        } catch {
          throw operationError(
            "invalid_input",
            `Input for integration tool ${name} did not match its declared schema.`,
          );
        }
        const invocationWork = Promise.resolve().then(() => {
          if (this.#faultedProviders.has(provider)) throw new ProviderFaultedError();
          if (
            signal.aborted ||
            this.#closing ||
            this.#isSurfaceRevoking(manifest, toolCapabilities)
          ) {
            if (context?.signal.aborted) throw cancellationError(context.signal);
            throw operationError("disabled", `${manifest.name} access is being revoked.`);
          }
          return provider.invoke(name, decodedInput, { signal });
        });
        this.#activeInvocationWork.add(invocationWork);
        void invocationWork.then(
          () => this.#activeInvocationWork.delete(invocationWork),
          () => this.#activeInvocationWork.delete(invocationWork),
        );
        const result = await invocationWork;
        if (controller.signal.aborted) {
          throw operationError("disabled", `${manifest.name} access was revoked.`);
        }
        if (context?.signal.aborted) throw cancellationError(context.signal);
        return result;
      } catch (error) {
        if (controller.signal.aborted) {
          throw operationError("disabled", `${manifest.name} access was revoked.`);
        }
        if (context?.signal.aborted) throw cancellationError(context.signal);
        if (error instanceof ProviderStatusTimeoutError) {
          throw operationError(
            "operation_failed",
            `${manifest.name} did not become ready before the status timeout.`,
          );
        }
        if (error instanceof ProviderStatusContractError || error instanceof ProviderFaultedError) {
          throw operationError(
            "operation_failed",
            error instanceof ProviderFaultedError
              ? `${manifest.name} is unavailable until its connection is reset.`
              : `${manifest.name} returned an invalid provider status.`,
          );
        }
        throw error;
      } finally {
        active.delete(controller);
        this.#activeInvocationToolNames.delete(controller);
        this.#activeInvocationGrantedCapabilities.delete(controller);
        this.#activeInvocationCompletionsByController.delete(controller);
        if (active.size === 0) this.#activeInvocations.delete(manifest.id);
        finishInvocation();
        this.#activeInvocationCompletions.delete(invocationCompletion);
        integrationCompletions.delete(invocationCompletion);
        if (integrationCompletions.size === 0) {
          this.#activeInvocationCompletionsByIntegration.delete(manifest.id);
        }
      }
    }
    throw operationError("not_found", `Integration tool ${name} was not found.`);
  }
}

let activeRegistry: RegistryRuntime | null = null;
const registryObservers = new Set<(registry: RegistryRuntime) => void>();
const registryLifecycleObservers = new Set<(registry: RegistryRuntime) => void>();

function notifyRegistryLifecycleObserver(
  observer: (registry: RegistryRuntime) => void,
  registry: RegistryRuntime,
): void {
  try {
    observer(registry);
  } catch {
    // Lifecycle notification is observational. One broken subscriber must not break the active
    // registry or prevent other consumers from receiving startup and restart notifications.
  }
}

export function getIntegrationRegistry(): RegistryRuntime {
  if (!activeRegistry) throw new Error("Integration registry has not started.");
  return activeRegistry;
}

export function getIntegrationRegistryOptional(): RegistryRuntime | null {
  return activeRegistry;
}

export function awaitIntegrationRegistry(): Promise<RegistryRuntime> {
  if (activeRegistry) return Promise.resolve(activeRegistry);
  return new Promise((resolve) => {
    const observer = (registry: RegistryRuntime) => {
      registryObservers.delete(observer);
      resolve(registry);
    };
    registryObservers.add(observer);
  });
}

export function observeIntegrationRegistry(
  observer: (registry: RegistryRuntime) => void,
): () => void {
  registryLifecycleObservers.add(observer);
  if (activeRegistry) notifyRegistryLifecycleObserver(observer, activeRegistry);
  return () => registryLifecycleObservers.delete(observer);
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
      makeBuiltinIntegrations(secrets, {
        includeFixtures: process.env.TRITONAI_ENABLE_INTEGRATION_FIXTURES === "1",
      }),
      skillMaterializer,
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => registry.close()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("integration registry shutdown failed", { cause }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (activeRegistry === registry) activeRegistry = null;
          }),
        ),
      ),
    );
    yield* Effect.promise(() => registry.snapshot());
    activeRegistry = registry;
    for (const observer of registryObservers) observer(registry);
    for (const observer of registryLifecycleObservers) {
      notifyRegistryLifecycleObserver(observer, registry);
    }
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
