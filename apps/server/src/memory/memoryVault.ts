/**
 * Layout of the memory folder and the files Harness owns inside it.
 *
 * `<memoryDir>/` is the parent for every memory system. `general/` is the
 * first one: an Obsidian-style vault of daily notes, project notes, and an
 * inbox. Later systems (teams, project heads) get their own sibling folders.
 *
 * Every file Harness generates belongs to one device and carries that device's
 * label in its name, such as `Daily/2026/2026-09-29 MacBook Pro (3f2a).md`.
 * Only that device ever writes it, so a vault shared between machines never
 * has two writers for one file. A device's own records live in
 * `.devices/<environment id>/`.
 */
// @effect-diagnostics nodeBuiltinImport:off - Vault paths identify independent skills in a shared Codex home.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { isLocalDay } from "./memoryDays.ts";
import { deviceFileLabel } from "./memoryNotes.ts";

const MEMORY_SKILL_MARKER = "<!-- Managed by TritonAI Harness Memory. -->";
const VAULT_GUIDE_MARKER =
  "<!-- Managed by TritonAI Harness Memory. Changes here are replaced. -->";

export function memorySkillName(vaultPath: string): string {
  return `tritonai-memory-${NodeCrypto.createHash("sha256").update(vaultPath).digest("hex").slice(0, 32)}`;
}

function memorySkillOwnerMarker(vaultPath: string): string {
  return `<!-- Memory vault: ${JSON.stringify(vaultPath)} -->`;
}

/** Pretty JSON for the small state files people may open to see what Memory did. */
function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(contents: string): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

export function sha256Bytes(contents: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

export interface GeneralVaultPaths {
  readonly root: string;
  readonly guide: string;
  readonly daily: string;
  readonly projects: string;
  readonly inbox: string;
  readonly notes: string;
  readonly devices: string;
}

export function generalVaultPaths(path: Path.Path, memoryDir: string): GeneralVaultPaths {
  const root = path.join(memoryDir, "general");
  return {
    root,
    guide: path.join(root, "AGENTS.md"),
    daily: path.join(root, "Daily"),
    projects: path.join(root, "Projects"),
    inbox: path.join(root, "Inbox"),
    notes: path.join(root, "Notes"),
    devices: path.join(root, ".devices"),
  };
}

/** This machine as it appears in the vault. */
export interface MemoryDevice {
  /** The server environment id; names the device's `.devices/` folder. */
  readonly id: string;
  readonly shortId: string;
  /** The computer name when the device first wrote to the vault. */
  readonly name: string;
  /** `name (shortId)`, used in every file name this device writes. */
  readonly label: string;
}

export interface DevicePaths {
  readonly root: string;
  readonly record: string;
  readonly coverage: string;
  readonly partial: string;
  readonly written: string;
  /** This device's agents write inbox notes here. */
  readonly inbox: string;
  readonly processed: string;
}

export function devicePaths(
  path: Path.Path,
  vault: GeneralVaultPaths,
  device: Pick<MemoryDevice, "id" | "shortId">,
): DevicePaths {
  const root = path.join(vault.devices, device.id);
  const inbox = path.join(vault.inbox, device.shortId);
  return {
    root,
    record: path.join(root, "device.json"),
    coverage: path.join(root, "coverage.json"),
    partial: path.join(root, "partial.json"),
    written: path.join(root, "written.json"),
    inbox,
    processed: path.join(inbox, "processed"),
  };
}

const DeviceRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  shortId: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  lastSeen: Schema.String,
});
const decodeDeviceRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceRecord));

const readDeviceRecord = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(file).pipe(Effect.option);
    if (raw._tag === "None") return null;
    const record = yield* decodeDeviceRecord(raw.value).pipe(Effect.option);
    return record._tag === "Some" ? record.value : null;
  });

/** Characters that break wiki links or are invalid in Windows file names. */
function fileSafeName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|#^[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "")
    .slice(0, 40)
    .trim();
  return cleaned.length > 0 ? cleaned : "Computer";
}

/** The device's record, if it has written to the vault before. Read-only. */
export const findMemoryDevice = Effect.fn("memory.findMemoryDevice")(function* (
  vault: GeneralVaultPaths,
  environmentId: string,
) {
  const path = yield* Path.Path;
  const record = yield* readDeviceRecord(path.join(vault.devices, environmentId, "device.json"));
  if (!record || record.id !== environmentId) return null;
  return {
    id: record.id,
    shortId: record.shortId,
    name: record.name,
    label: deviceFileLabel(record),
  } satisfies MemoryDevice;
});

/**
 * Registers this machine in the vault, or refreshes its last-seen time. The
 * name and short code are kept from the first registration so file names stay
 * stable when the computer is renamed. The short code grows when another
 * device already uses it.
 */
export const registerMemoryDevice = Effect.fn("memory.registerMemoryDevice")(function* (input: {
  readonly vault: GeneralVaultPaths;
  readonly environmentId: string;
  readonly computerName: string;
  readonly platform: string;
  readonly nowIso: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const existing = yield* findMemoryDevice(input.vault, input.environmentId);
  let shortId = existing?.shortId;
  if (!shortId) {
    const taken = new Set<string>();
    const ids = yield* fs
      .readDirectory(input.vault.devices)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const id of ids) {
      if (id === input.environmentId) continue;
      const other = yield* readDeviceRecord(path.join(input.vault.devices, id, "device.json"));
      if (other) taken.add(other.shortId);
    }
    const hex = input.environmentId.replace(/[^0-9a-f]/giu, "").toLowerCase();
    const candidates = [4, 6, 8, 12, 32].map((length) => hex.slice(0, length));
    shortId = candidates.find((candidate) => !taken.has(candidate)) ?? hex;
  }
  const device = {
    id: input.environmentId,
    shortId,
    name: existing?.name ?? fileSafeName(input.computerName),
  };
  const paths = devicePaths(path, input.vault, device);
  yield* writeFileStringAtomically({
    filePath: paths.record,
    contents: jsonFile({
      version: 1,
      ...device,
      platform: input.platform,
      lastSeen: input.nowIso,
    }),
  });
  return { ...device, label: deviceFileLabel(device) } satisfies MemoryDevice;
});

function vaultGuide(device: MemoryDevice): string {
  return `${VAULT_GUIDE_MARKER}
# General memory

This folder is the general memory vault for TritonAI Harness. It is plain Markdown with Obsidian links, so you can open it in Obsidian or any editor. It can hold notes from more than one computer. Each computer writes only its own files, and every file it writes ends with its name and short code, such as \`${device.label}\`.

- \`Daily/<year>/\` has one note per computer per day, such as \`Daily/2026/2026-09-29 ${device.label}.md\`. Read every note for a day. A note with \`status: partial\` covers today so far and is updated every few hours.
- \`Projects/<project>/\` has one note per computer for each project, with a line for each day it was worked on.
- \`Inbox/<short code>/\` holds notes agents on that computer wrote. The next daily note includes them and moves them to \`Inbox/<short code>/processed/\`.
- \`Notes/\` is for your own notes. Harness never changes them. If you edit a note Harness generated, Harness saves your copy under \`Notes/Recovered/\` before writing that note again.
- \`.devices/<id>/device.json\` names each computer. \`.devices/<id>/coverage.json\` lists the days that computer has summarized: every day from \`coveredFrom\` through \`lastSummarizedDay\`, and the note written for each day that had activity. A day in that range without a listed note had no activity on that computer. A listed note that is missing here has not reached this computer yet.

Agents: only write here when the user asks you to remember something or close out work. Create a new file in your computer's inbox named \`YYYY-MM-DD-HHMM-short-topic.md\` with Summary, Work, Links, and Open Loops sections. Never edit Daily or Projects notes. Never store secrets, tokens, or credentials.
`;
}

/**
 * Creates the vault folders and keeps the guide current. A guide Harness did
 * not write is moved to `Notes/` rather than replaced. Notes left directly in
 * `Inbox/` are claimed by this device so its next summary includes them.
 */
export const ensureGeneralVault = Effect.fn("memory.ensureGeneralVault")(function* (
  vault: GeneralVaultPaths,
  device: MemoryDevice,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = devicePaths(path, vault, device);
  for (const directory of [vault.daily, vault.projects, vault.notes, paths.processed]) {
    yield* fs.makeDirectory(directory, { recursive: true });
  }
  const looseNotes = yield* fs
    .readDirectory(vault.inbox)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const name of looseNotes.toSorted()) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const from = path.join(vault.inbox, name);
    const info = yield* fs.stat(from).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") continue;
    const stem = name.slice(0, -".md".length);
    let to = path.join(paths.inbox, name);
    for (let attempt = 2; yield* fs.exists(to); attempt++) {
      to = path.join(paths.inbox, `${stem}-${attempt}.md`);
    }
    yield* fs.rename(from, to);
  }
  const guide = vaultGuide(device);
  const existing = yield* fs.readFileString(vault.guide).pipe(Effect.option);
  if (existing._tag === "Some") {
    if (existing.value === guide) return;
    if (!existing.value.startsWith(VAULT_GUIDE_MARKER)) {
      yield* preserveUserFile(vault, existing.value, "AGENTS (previous).md");
    }
  }
  yield* writeFileStringAtomically({ filePath: vault.guide, contents: guide });
});

/**
 * Saves `contents` under `Notes/Recovered/`, keeping the relative path. An
 * identical copy already there is reused; a different one gets a numbered name.
 */
const preserveUserFile = Effect.fn("memory.preserveUserFile")(function* (
  vault: GeneralVaultPaths,
  contents: string,
  relativePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(vault.notes, "Recovered", relativePath);
  const extension = path.extname(target);
  const stem = target.slice(0, target.length - extension.length);
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? target : `${stem} ${attempt}${extension}`;
    const existing = yield* fs.readFileString(candidate).pipe(Effect.option);
    if (existing._tag === "Some" && existing.value === contents) return candidate;
    if (existing._tag === "None") {
      yield* writeFileStringAtomically({ filePath: candidate, contents });
      return candidate;
    }
  }
});

const WrittenFiles = Schema.Struct({
  version: Schema.Literal(1),
  /** Vault-relative path to the sha256 of what Harness last wrote there. */
  files: Schema.Record(Schema.String, Schema.String),
});
const decodeWrittenFiles = Schema.decodeUnknownEffect(Schema.fromJsonString(WrittenFiles));

const readWrittenFiles = Effect.fn("memory.readWrittenFiles")(function* (device: DevicePaths) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(device.written).pipe(Effect.option);
  if (raw._tag === "None") return {};
  return yield* decodeWrittenFiles(raw.value).pipe(
    Effect.map((value): Record<string, string> => ({ ...value.files })),
    Effect.orElseSucceed((): Record<string, string> => ({})),
  );
});

const writeWrittenFiles = (device: DevicePaths, files: Record<string, string>) =>
  writeFileStringAtomically({
    filePath: device.written,
    contents: jsonFile({ version: 1, files }),
  });

/**
 * Writes a file this device generates. If the file on disk is not what Harness
 * last wrote there, someone edited it, so their copy is saved under
 * `Notes/Recovered/` first. Returns the written contents' hash.
 */
export const writeGeneratedFile = Effect.fn("memory.writeGeneratedFile")(function* (input: {
  readonly vault: GeneralVaultPaths;
  readonly device: DevicePaths;
  readonly filePath: string;
  readonly contents: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const relativePath = path.relative(input.vault.root, input.filePath);
  const written = yield* readWrittenFiles(input.device);
  const existing = yield* fs.readFileString(input.filePath).pipe(Effect.option);
  if (
    existing._tag === "Some" &&
    existing.value !== input.contents &&
    sha256(existing.value) !== written[relativePath]
  ) {
    yield* preserveUserFile(input.vault, existing.value, relativePath);
  }
  const hash = sha256(input.contents);
  yield* writeFileStringAtomically({ filePath: input.filePath, contents: input.contents });
  written[relativePath] = hash;
  yield* writeWrittenFiles(input.device, written);
  return hash;
});

/**
 * Removes a file this device generated that no longer applies, such as a day
 * note whose only thread was deleted. An edited copy is saved first.
 */
export const removeGeneratedFile = Effect.fn("memory.removeGeneratedFile")(function* (input: {
  readonly vault: GeneralVaultPaths;
  readonly device: DevicePaths;
  readonly filePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const existing = yield* fs.readFileString(input.filePath).pipe(Effect.option);
  if (existing._tag === "None") return;
  const relativePath = path.relative(input.vault.root, input.filePath);
  const written = yield* readWrittenFiles(input.device);
  if (sha256(existing.value) !== written[relativePath]) {
    yield* preserveUserFile(input.vault, existing.value, relativePath);
  }
  yield* fs.remove(input.filePath);
  delete written[relativePath];
  yield* writeWrittenFiles(input.device, written);
});

const CoveredNote = Schema.Struct({ path: Schema.String, sha256: Schema.String });
const Coverage = Schema.Struct({
  version: Schema.Literal(1),
  lastSummarizedDay: Schema.String,
  /** First day of the unbroken run ending at `lastSummarizedDay`. */
  coveredFrom: Schema.NullOr(Schema.String),
  /** Final notes by day. Covered days missing here had no activity. */
  notes: Schema.Record(Schema.String, CoveredNote),
});
const decodeCoverage = Schema.decodeUnknownEffect(Schema.fromJsonString(Coverage));

/**
 * The days the summarizer has examined without a gap, from `coveredFrom`
 * through `lastSummarizedDay`, and the final note written for each day that
 * had activity. `coveredFrom` is null when unknown.
 */
export interface DailySummaryProgress {
  readonly coveredFrom: string | null;
  readonly lastSummarizedDay: string;
  readonly notes: Readonly<Record<string, { readonly path: string; readonly sha256: string }>>;
}

/** Summary progress, or null before the first summary. */
export const readSummaryProgress = Effect.fn("memory.readSummaryProgress")(function* (
  paths: DevicePaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(paths.coverage).pipe(Effect.option);
  if (raw._tag === "None") return null;
  const state = yield* decodeCoverage(raw.value).pipe(Effect.option);
  if (state._tag === "None" || !isLocalDay(state.value.lastSummarizedDay)) return null;
  const coveredFrom = state.value.coveredFrom;
  return {
    coveredFrom:
      coveredFrom && isLocalDay(coveredFrom) && coveredFrom <= state.value.lastSummarizedDay
        ? coveredFrom
        : null,
    lastSummarizedDay: state.value.lastSummarizedDay,
    notes: state.value.notes,
  } satisfies DailySummaryProgress;
});

export const writeSummaryProgress = (paths: DevicePaths, progress: DailySummaryProgress) =>
  writeFileStringAtomically({
    filePath: paths.coverage,
    contents: jsonFile({ version: 1, ...progress }),
  });

const PartialProgress = Schema.Struct({
  version: Schema.Literal(1),
  day: Schema.String,
  /** When today's note was last written. */
  writtenAt: Schema.String,
  /** What the note was built from; an unchanged fingerprint skips the model. */
  fingerprint: Schema.String,
});
export type PartialProgress = Omit<typeof PartialProgress.Type, "version">;
const decodePartialProgress = Schema.decodeUnknownEffect(Schema.fromJsonString(PartialProgress));

export const readPartialProgress = Effect.fn("memory.readPartialProgress")(function* (
  paths: DevicePaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(paths.partial).pipe(Effect.option);
  if (raw._tag === "None") return null;
  const state = yield* decodePartialProgress(raw.value).pipe(Effect.option);
  return state._tag === "Some" ? state.value : null;
});

export const writePartialProgress = (paths: DevicePaths, progress: PartialProgress) =>
  writeFileStringAtomically({
    filePath: paths.partial,
    contents: jsonFile({ version: 1, ...progress }),
  });

export function renderMemorySkill(input: {
  readonly vaultPath: string;
  readonly sessionsPath: string;
  readonly device: MemoryDevice;
}): string {
  return `---
name: ${memorySkillName(input.vaultPath)}
description: ${JSON.stringify(`Check the user's TritonAI Harness memory at ${input.vaultPath} for past work, decisions, open loops, and links. Use when the user asks what happened before, what is left on a project, or refers to earlier work.`)}
---

${MEMORY_SKILL_MARKER}
${memorySkillOwnerMarker(input.vaultPath)}

# Memory

The general memory vault is at:

\`${input.vaultPath}\`

It can hold notes from several of the user's computers. This computer is \`${input.device.label}\`. Every generated file name ends with the computer that wrote it.

## Reading

1. Search the vault for the subject with \`rg -n -i "search terms"\` in the vault folder.
2. Read matching notes in \`Projects/<project>/\` first, then recent notes in \`Daily/<year>/\`. A day can have one note per computer, such as \`2026-09-29 ${input.device.label}.md\`; read all of them. A note with \`status: partial\` covers today so far and may be incomplete.
3. Days without activity have no note. \`.devices/<id>/coverage.json\` records, per computer, the days covered from \`coveredFrom\` through \`lastSummarizedDay\` and the note written for each day with activity. A day in that range without a listed note had no activity on that computer. A listed note that is missing from the vault has not reached this computer yet; say so instead of assuming nothing happened. A day outside the range was never summarized, so check the session files.
4. For more detail, open the session file listed under Threads in a daily note. Extract only the relevant messages. Session files on this computer live under \`${input.sessionsPath}\`; a note may list a Codex thread id instead, which appears in the session file name. Session files from another computer are not available here.
5. The user's own notes are in \`Notes/\`.
6. Say which notes you used, with dates and computers. Say when notes look stale or incomplete.

## Writing

Only write when the user asks you to remember something or close out work.

- Create one new file: \`Inbox/${input.device.shortId}/YYYY-MM-DD-HHMM-short-topic.md\`. Do not use \`:\` in file names.
- Use these sections: Summary, Work, Links, Open Loops.
- Never edit \`Daily/\` or \`Projects/\` notes. Never store secrets, tokens, or credentials.
`;
}

/**
 * Installs or refreshes the memory skill in the Codex home. A folder with the
 * same name that Harness did not write is left alone.
 */
export const installMemorySkill = Effect.fn("memory.installMemorySkill")(function* (input: {
  readonly skillsDirectory: string;
  readonly vaultPath: string;
  readonly contents: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillFile = path.join(input.skillsDirectory, memorySkillName(input.vaultPath), "SKILL.md");
  const existing = yield* fs.readFileString(skillFile).pipe(Effect.option);
  if (existing._tag === "Some") {
    if (
      !existing.value.includes(MEMORY_SKILL_MARKER) ||
      !existing.value.includes(memorySkillOwnerMarker(input.vaultPath))
    )
      return "user-owned" as const;
    if (existing.value === input.contents) return "current" as const;
  } else if (yield* fs.exists(path.dirname(skillFile))) {
    return "user-owned" as const;
  }
  yield* writeFileStringAtomically({ filePath: skillFile, contents: input.contents });
  return "installed" as const;
});

/** Removes only this vault's skill if Harness installed it. */
export const removeMemorySkill = Effect.fn("memory.removeMemorySkill")(function* (input: {
  readonly skillsDirectory: string;
  readonly vaultPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(input.skillsDirectory, memorySkillName(input.vaultPath));
  const existing = yield* fs
    .readFileString(path.join(skillDirectory, "SKILL.md"))
    .pipe(Effect.option);
  if (
    existing._tag === "None" ||
    !existing.value.includes(MEMORY_SKILL_MARKER) ||
    !existing.value.includes(memorySkillOwnerMarker(input.vaultPath))
  )
    return false;
  yield* fs.remove(skillDirectory, { recursive: true });
  return true;
});
