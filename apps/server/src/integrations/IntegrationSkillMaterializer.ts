// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off
import { CodexSettings, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { expandHomePath } from "../pathExpansion.ts";

const MARKER = ".tritonai-integration-skill.json";
const SWAP_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const STAGING_DIRECTORY = new RegExp(`^\\.(.+)\\.(${SWAP_UUID})\\.staging$`, "iu");
const BACKUP_DIRECTORY = new RegExp(`^(.+)\\.(${SWAP_UUID})\\.backup$`, "iu");
const DEFAULT_STALE_SWAP_AGE_MS = 60 * 60 * 1_000;
const activeSwapDirectories = new Set<string>();

export interface IntegrationSkillSync {
  readonly integrationId: string;
  readonly packageRoot: string | null;
  readonly activeSkills: ReadonlyArray<string>;
}

export interface IntegrationSkillMaterializer {
  sync(input: IntegrationSkillSync): Promise<void>;
}

interface SkillMarker {
  readonly version?: number;
  readonly integrationId?: string;
  readonly skill?: string;
}

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const defaultCodexInstanceId = ProviderInstanceId.make("codex");

export function resolveIntegrationCodexHomes(
  baseDir: string,
  settings: ServerSettings,
): ReadonlyArray<string> {
  const rawConfigs: Array<unknown> = [];
  const defaultInstance = settings.providerInstances[defaultCodexInstanceId];
  if (defaultInstance?.driver === "codex") rawConfigs.push(defaultInstance.config ?? {});
  else if (defaultInstance === undefined) rawConfigs.push(settings.providers.codex);
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instanceId !== "codex" && instance.driver === "codex")
      rawConfigs.push(instance.config ?? {});
  }
  const homes = rawConfigs.flatMap((rawConfig) => {
    try {
      const config = decodeCodexSettings(rawConfig);
      const configured = config.homePath.trim();
      return [
        NodePath.resolve(
          expandHomePath(configured.length > 0 ? configured : NodePath.join(baseDir, "codex")),
        ),
      ];
    } catch {
      return [];
    }
  });
  return [...new Set(homes)];
}

export const noIntegrationSkills: IntegrationSkillMaterializer = {
  sync: async () => undefined,
};

async function exists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

function declaredSkillName(content: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  const value = frontmatter ? /^name:\s*(.+?)\s*$/mu.exec(frontmatter)?.[1]?.trim() : undefined;
  if (!value) return null;
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;
}

function transientSwapSkill(name: string): string | null {
  return STAGING_DIRECTORY.exec(name)?.[1] ?? BACKUP_DIRECTORY.exec(name)?.[1] ?? null;
}

export class CodexIntegrationSkillMaterializer implements IntegrationSkillMaterializer {
  #codexHomes: ReadonlyArray<string>;
  #mutation: Promise<void> = Promise.resolve();
  readonly #now: () => number;
  readonly #staleSwapAgeMs: number;

  constructor(
    codexHomes: ReadonlyArray<string>,
    options: { readonly now?: () => number; readonly staleSwapAgeMs?: number } = {},
  ) {
    this.#codexHomes = [...new Set(codexHomes.map((home) => NodePath.resolve(home)))];
    this.#now = options.now ?? Date.now;
    this.#staleSwapAgeMs = options.staleSwapAgeMs ?? DEFAULT_STALE_SWAP_AGE_MS;
  }

  #serialize<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#mutation.then(operation, operation);
    this.#mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  sync(input: IntegrationSkillSync): Promise<void> {
    return this.#serialize(async () => {
      for (const home of this.#codexHomes) await this.#syncHome(home, input);
    });
  }

  setCodexHomes(codexHomes: ReadonlyArray<string>): Promise<void> {
    return this.#serialize(async () => {
      const next = [...new Set(codexHomes.map((home) => NodePath.resolve(home)))];
      const removed = this.#codexHomes.filter((home) => !next.includes(home));
      for (const home of removed) await this.#removeOwnedSkills(home);
      this.#codexHomes = next;
    });
  }

  async #removeOwnedSkills(home: string): Promise<void> {
    const skillsRoot = NodePath.join(home, "skills");
    let entries: ReadonlyArray<NodeFS.Dirent>;
    try {
      entries = await NodeFSP.readdir(skillsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = NodePath.join(skillsRoot, entry.name);
      try {
        const marker = JSON.parse(
          await NodeFSP.readFile(NodePath.join(target, MARKER), "utf8"),
        ) as SkillMarker & { readonly version?: number };
        if (
          marker.version === 1 &&
          typeof marker.integrationId === "string" &&
          typeof marker.skill === "string"
        ) {
          await NodeFSP.rm(target, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
          continue;
        throw error;
      }
    }
  }

  async #syncHome(home: string, input: IntegrationSkillSync): Promise<void> {
    const skillsRoot = NodePath.join(home, "skills");
    const expected = new Map(
      input.activeSkills.map((name) => [name, NodePath.join(skillsRoot, name)]),
    );
    const skillsRootExists = await exists(skillsRoot);
    if (!skillsRootExists && expected.size === 0) return;
    if (!skillsRootExists) await NodeFSP.mkdir(skillsRoot, { recursive: true, mode: 0o700 });

    for (const entry of await NodeFSP.readdir(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = NodePath.join(skillsRoot, entry.name);
      const swapSkill = transientSwapSkill(entry.name);
      if (swapSkill !== null) {
        if (await this.#isStaleOwnedSwap(target, swapSkill)) {
          await NodeFSP.rm(target, { recursive: true, force: true });
        }
        continue;
      }
      const markerPath = NodePath.join(target, MARKER);
      let marker: SkillMarker | null = null;
      try {
        marker = JSON.parse(await NodeFSP.readFile(markerPath, "utf8")) as SkillMarker;
      } catch {
        continue;
      }
      if (
        marker?.version === 1 &&
        marker?.integrationId === input.integrationId &&
        typeof marker.skill === "string" &&
        !expected.has(marker.skill)
      ) {
        await NodeFSP.rm(target, { recursive: true, force: true });
      }
    }

    for (const [skill, target] of expected) {
      if (!input.packageRoot) throw new Error(`Active integration skill ${skill} has no package.`);
      const source = NodePath.join(input.packageRoot, "skills", skill);
      const sourceEntrypoint = NodePath.join(source, "SKILL.md");
      if (!(await exists(sourceEntrypoint))) {
        throw new Error(`Integration package is missing skills/${skill}/SKILL.md.`);
      }
      const sourceContent = await NodeFSP.readFile(sourceEntrypoint, "utf8");
      if (declaredSkillName(sourceContent) !== skill) {
        throw new Error(`Integration skill ${skill} must declare matching SKILL.md frontmatter.`);
      }
      if (await exists(target)) {
        try {
          const marker = JSON.parse(
            await NodeFSP.readFile(NodePath.join(target, MARKER), "utf8"),
          ) as SkillMarker;
          if (
            marker.version !== 1 ||
            marker.integrationId !== input.integrationId ||
            marker.skill !== skill
          ) {
            throw new Error("ownership mismatch");
          }
        } catch {
          throw new Error(
            `Refusing to replace unmanaged Codex skill ${NodePath.basename(target)}.`,
          );
        }
      }
      const staging = NodePath.join(
        skillsRoot,
        `.${NodePath.basename(target)}.${crypto.randomUUID()}.staging`,
      );
      const backup = `${target}.${crypto.randomUUID()}.backup`;
      activeSwapDirectories.add(staging);
      activeSwapDirectories.add(backup);
      let backedUp = false;
      try {
        await NodeFSP.cp(source, staging, { recursive: true, errorOnExist: true });
        await NodeFSP.writeFile(
          NodePath.join(staging, MARKER),
          `${JSON.stringify({ version: 1, integrationId: input.integrationId, skill }, null, 2)}\n`,
          { mode: 0o600 },
        );
        if (await exists(target)) {
          await NodeFSP.rename(target, backup);
          backedUp = true;
        }
        await NodeFSP.rename(staging, target);
        if (backedUp) await NodeFSP.rm(backup, { recursive: true, force: true });
      } catch (error) {
        await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        if (backedUp && !(await exists(target))) await NodeFSP.rename(backup, target);
        throw error;
      } finally {
        activeSwapDirectories.delete(staging);
        activeSwapDirectories.delete(backup);
      }
    }
  }

  async #isStaleOwnedSwap(target: string, expectedSkill: string): Promise<boolean> {
    if (activeSwapDirectories.has(target)) return false;
    try {
      const marker = JSON.parse(
        await NodeFSP.readFile(NodePath.join(target, MARKER), "utf8"),
      ) as SkillMarker;
      if (
        marker.version !== 1 ||
        typeof marker.integrationId !== "string" ||
        marker.skill !== expectedSkill
      ) {
        return false;
      }
      const metadata = await NodeFSP.stat(target);
      const lastChangedAt = Math.max(metadata.mtimeMs, metadata.ctimeMs);
      return this.#now() - lastChangedAt >= this.#staleSwapAgeMs;
    } catch {
      return false;
    }
  }
}
