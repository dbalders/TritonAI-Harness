/**
 * Layout of the memory folder and the files Harness owns inside it.
 *
 * `<memoryDir>/` is the parent for every memory system. `general/` is the
 * first one: an Obsidian-style vault of daily notes, project notes, and an
 * inbox. Later systems (teams, project heads) get their own sibling folders.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { isLocalDay } from "./memoryDays.ts";

const MEMORY_SKILL_NAME = "tritonai-memory";
const MEMORY_SKILL_MARKER = "<!-- Managed by TritonAI Harness Memory. -->";

export interface GeneralVaultPaths {
  readonly root: string;
  readonly guide: string;
  readonly daily: string;
  readonly projects: string;
  readonly inbox: string;
  readonly processed: string;
  readonly stateFile: string;
}

export function generalVaultPaths(path: Path.Path, memoryDir: string): GeneralVaultPaths {
  const root = path.join(memoryDir, "general");
  return {
    root,
    guide: path.join(root, "AGENTS.md"),
    daily: path.join(root, "Daily"),
    projects: path.join(root, "Projects"),
    inbox: path.join(root, "Inbox"),
    processed: path.join(root, "Inbox", "processed"),
    stateFile: path.join(root, ".state", "daily-summary.json"),
  };
}

const VAULT_GUIDE = `# General memory

This folder is the general memory vault for TritonAI Harness. It is plain Markdown with Obsidian links, so you can open it in Obsidian or any editor.

- \`Daily/\` has one note per day with thread activity, written in the background after the day ends. \`.state/daily-summary.json\` records the last day covered. A day on or before it with no note had no activity; later days are not summarized yet.
- \`Projects/\` has one note per project. Write your own notes under Pinned; the daily summary only adds lines under Recent.
- \`Inbox/\` holds notes agents or you write during the day. The next daily summary includes them and moves them to \`Inbox/processed/\`.

Agents: only write here when the user asks you to remember something or close out work. Create a new file in \`Inbox/\` named \`YYYY-MM-DD-HHMM-short-topic.md\` with Summary, Work, Links, and Open Loops sections. Never edit Daily or Projects notes. Never store secrets, tokens, or credentials.
`;

/** Creates the vault folders and guide. Existing files are left alone. */
export const ensureGeneralVault = Effect.fn("memory.ensureGeneralVault")(function* (
  paths: GeneralVaultPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of [paths.daily, paths.projects, paths.inbox, paths.processed]) {
    yield* fs.makeDirectory(directory, { recursive: true });
  }
  if (!(yield* fs.exists(paths.guide))) {
    yield* writeFileStringAtomically({ filePath: paths.guide, contents: VAULT_GUIDE });
  }
});

const DailySummaryState = Schema.Struct({
  version: Schema.Literal(1),
  lastSummarizedDay: Schema.String,
});
const decodeDailySummaryState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DailySummaryState),
);

/** The last finished day with a note, or null before the first summary. */
export const readLastSummarizedDay = Effect.fn("memory.readLastSummarizedDay")(function* (
  paths: GeneralVaultPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(paths.stateFile).pipe(Effect.option);
  if (raw._tag === "None") return null;
  const state = yield* decodeDailySummaryState(raw.value).pipe(Effect.option);
  return state._tag === "Some" && isLocalDay(state.value.lastSummarizedDay)
    ? state.value.lastSummarizedDay
    : null;
});

export const writeLastSummarizedDay = (paths: GeneralVaultPaths, day: string) =>
  writeFileStringAtomically({
    filePath: paths.stateFile,
    contents: `${JSON.stringify({ version: 1, lastSummarizedDay: day }, null, 2)}\n`,
  });

export function renderMemorySkill(input: {
  readonly vaultPath: string;
  readonly sessionsPath: string;
}): string {
  return `---
name: ${MEMORY_SKILL_NAME}
description: Check the user's TritonAI Harness memory for past work, decisions, open loops, and links. Use when the user asks what happened before, what is left on a project, or refers to earlier work.
---

${MEMORY_SKILL_MARKER}

# Memory

The general memory vault is at:

\`${input.vaultPath}\`

## Reading

1. Search the vault for the subject with \`rg -n -i "search terms"\` in the vault folder.
2. Read matching notes in \`Projects/\` first, then recent notes in \`Daily/\`.
   Days without thread activity have no note. \`.state/daily-summary.json\` in the vault records the last day covered: a missing note on or before that day means no activity, and a missing note after it means the day is not summarized yet.
3. For more detail, open the session file listed under Threads in a daily note. Extract only the relevant messages. Session files live under \`${input.sessionsPath}\`; a daily note may list a Codex thread id instead, which appears in the session file name.
4. Say which notes you used, with dates. Say when notes look stale or incomplete.

## Writing

Only write when the user asks you to remember something or close out work.

- Create one new file: \`Inbox/YYYY-MM-DD-HHMM-short-topic.md\`. Do not use \`:\` in file names.
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
  readonly contents: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillFile = path.join(input.skillsDirectory, MEMORY_SKILL_NAME, "SKILL.md");
  const existing = yield* fs.readFileString(skillFile).pipe(Effect.option);
  if (existing._tag === "Some") {
    if (!existing.value.includes(MEMORY_SKILL_MARKER)) return "user-owned" as const;
    if (existing.value === input.contents) return "current" as const;
  } else if (yield* fs.exists(path.dirname(skillFile))) {
    return "user-owned" as const;
  }
  yield* writeFileStringAtomically({ filePath: skillFile, contents: input.contents });
  return "installed" as const;
});

/** Removes the memory skill if Harness installed it. */
export const removeMemorySkill = Effect.fn("memory.removeMemorySkill")(function* (
  skillsDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(skillsDirectory, MEMORY_SKILL_NAME);
  const existing = yield* fs
    .readFileString(path.join(skillDirectory, "SKILL.md"))
    .pipe(Effect.option);
  if (existing._tag === "None" || !existing.value.includes(MEMORY_SKILL_MARKER)) return false;
  yield* fs.remove(skillDirectory, { recursive: true });
  return true;
});
