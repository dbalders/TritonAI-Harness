import {
  type ServerProviderSkillBundle,
  type ServerProviderSkillBundleFile,
  type ServerProviderSkillCatalog,
  type ServerProviderSkillCatalogEntry,
  ServerProviderSkillCatalogError,
  ServerProviderSkillInstallError,
} from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import * as VcsProcess from "../vcs/VcsProcess.ts";

export const PUBLIC_SKILLS_REPOSITORY_URL = "https://github.com/dbalders/UCSD-Skills-Library";
const PUBLIC_SKILLS_CLONE_URL = `${PUBLIC_SKILLS_REPOSITORY_URL}.git`;
const PUBLIC_SKILLS_DEFAULT_BRANCH = "main";
const GIT_TIMEOUT_MS = 120_000;
const MAX_CATALOG_SKILLS = 200;
const MAX_SKILL_FILE_COUNT = 200;
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const SAFE_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

const PublicSkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  maintainer: Schema.optional(Schema.String),
});
const decodePublicSkillFrontmatter = Schema.decodeUnknownEffect(fromYaml(PublicSkillFrontmatter));

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  readonly size: number | null;
  readonly path: string;
}

interface PublicSkillLocation {
  readonly id: string;
  readonly section: ServerProviderSkillCatalogEntry["section"];
  readonly folderName: string;
}

function schemaIssue(error: Schema.SchemaError): string {
  return SchemaIssue.makeFormatterDefault()(error.issue);
}

function catalogError(message: string, cause?: unknown) {
  return new ServerProviderSkillCatalogError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function installError(message: string, cause?: unknown) {
  return new ServerProviderSkillInstallError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function processOutput(stdout: string) {
  return stdout.trim();
}

function gitEnvironment(platform: NodeJS.Platform, homeDirectory: string): NodeJS.ProcessEnv {
  const nullDevice = platform === "win32" ? "NUL" : "/dev/null";
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  return {
    ...environment,
    HOME: homeDirectory,
    ...(platform === "win32" ? { USERPROFILE: homeDirectory } : {}),
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function hardenedGitArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return [
    "-c",
    "credential.helper=",
    "-c",
    "http.followRedirects=false",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.file.allow=never",
    ...args,
  ];
}

function resolveMainRevision(
  cwd: string,
): Effect.Effect<string, ServerProviderSkillCatalogError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const platform = yield* HostProcessPlatform;
    const result = yield* process
      .run({
        operation: "publicSkillRepository.gitLsRemote",
        command: "git",
        args: hardenedGitArgs([
          "ls-remote",
          "--refs",
          PUBLIC_SKILLS_CLONE_URL,
          `refs/heads/${PUBLIC_SKILLS_DEFAULT_BRANCH}`,
        ]),
        cwd,
        env: gitEnvironment(platform, cwd),
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.mapError((cause) =>
          catalogError("The public skills repository could not be reached.", cause),
        ),
      );
    if (result.stdoutTruncated || result.stderrTruncated) {
      return yield* catalogError("The public skills repository revision response was truncated.");
    }
    const [revision, refName] = processOutput(result.stdout).split(/\s+/u);
    if (!revision || !GIT_SHA_PATTERN.test(revision) || refName !== "refs/heads/main") {
      return yield* catalogError("The public skills repository returned an invalid main revision.");
    }
    return revision;
  });
}

function initializeRepository<E>(
  repositoryPath: string,
  revision: string,
  errorFactory: (message: string, cause?: unknown) => E,
): Effect.Effect<void, E, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const platform = yield* HostProcessPlatform;
    for (const command of [
      ["init", "--quiet", repositoryPath],
      ["-C", repositoryPath, "remote", "add", "origin", PUBLIC_SKILLS_CLONE_URL],
      ["-C", repositoryPath, "fetch", "--quiet", "--depth", "1", "origin", revision],
    ] as const) {
      const result = yield* process
        .run({
          operation: "publicSkillRepository.gitFetchRevision",
          command: "git",
          args: hardenedGitArgs(command),
          cwd: repositoryPath,
          env: gitEnvironment(platform, repositoryPath),
          timeoutMs: GIT_TIMEOUT_MS,
          maxOutputBytes: 256 * 1024,
        })
        .pipe(
          Effect.mapError((cause) =>
            errorFactory(
              `Public skills revision ${revision.slice(0, 12)} could not be fetched.`,
              cause,
            ),
          ),
        );
      if (result.stdoutTruncated || result.stderrTruncated) {
        return yield* Effect.fail(
          errorFactory(
            `Public skills revision ${revision.slice(0, 12)} produced truncated Git output.`,
          ),
        );
      }
    }
  });
}

function parseGitTree(output: string): ReadonlyArray<GitTreeEntry> | null {
  const entries: GitTreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = record.match(/^([0-7]{6}) ([^ ]+) ([0-9a-f]+)[ ]+([0-9]+|-)\t([\s\S]+)$/u);
    if (!match) return null;
    const [, mode, type, object, rawSize, path] = match;
    if (!mode || !type || !object || !GIT_SHA_PATTERN.test(object) || !rawSize || !path) {
      return null;
    }
    const size = rawSize === "-" ? null : Number(rawSize);
    if (size !== null && (!Number.isSafeInteger(size) || size < 0)) return null;
    entries.push({
      mode,
      type,
      object,
      size,
      path,
    });
  }
  return entries;
}

function listTree<E>(
  repositoryPath: string,
  revision: string,
  paths: ReadonlyArray<string>,
  errorFactory: (message: string, cause?: unknown) => E,
): Effect.Effect<ReadonlyArray<GitTreeEntry>, E, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const platform = yield* HostProcessPlatform;
    const result = yield* process
      .run({
        operation: "publicSkillRepository.gitListTree",
        command: "git",
        args: hardenedGitArgs([
          "-C",
          repositoryPath,
          "ls-tree",
          "-r",
          "-l",
          "-z",
          revision,
          "--",
          ...paths,
        ]),
        cwd: repositoryPath,
        env: gitEnvironment(platform, repositoryPath),
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: 2 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError((cause) =>
          errorFactory(
            `Public skills revision ${revision.slice(0, 12)} could not be inspected.`,
            cause,
          ),
        ),
      );
    if (result.stdoutTruncated || result.stderrTruncated) {
      return yield* Effect.fail(
        errorFactory(`Public skills revision ${revision.slice(0, 12)} returned a truncated tree.`),
      );
    }
    const tree = parseGitTree(result.stdout);
    if (!tree) {
      return yield* Effect.fail(
        errorFactory(
          `Public skills revision ${revision.slice(0, 12)} returned malformed tree data.`,
        ),
      );
    }
    return tree;
  });
}

function readBlob<E>(
  repositoryPath: string,
  object: string,
  expectedBytes: number,
  errorFactory: (message: string, cause?: unknown) => E,
): Effect.Effect<string, E, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const platform = yield* HostProcessPlatform;
    const result = yield* process
      .run({
        operation: "publicSkillRepository.gitReadBlob",
        command: "git",
        args: hardenedGitArgs(["-C", repositoryPath, "cat-file", "blob", object]),
        cwd: repositoryPath,
        env: gitEnvironment(platform, repositoryPath),
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: MAX_SKILL_BYTES + 1024,
      })
      .pipe(
        Effect.mapError((cause) => errorFactory("A public skill file could not be read.", cause)),
      );
    if (
      result.stdoutTruncated ||
      result.stderrTruncated ||
      Buffer.byteLength(result.stdout) !== expectedBytes ||
      result.stdout.includes("\0")
    ) {
      return yield* Effect.fail(
        errorFactory("A public skill file did not match its Git tree metadata."),
      );
    }
    return result.stdout;
  });
}

function extractFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  return match?.[1] ?? null;
}

function displayName(name: string): string {
  const preferred: Readonly<Record<string, string>> = {
    ai: "AI",
    tritonai: "TritonAI",
    ucsd: "UCSD",
  };
  return name
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => preferred[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parsePublicSkillLocation(id: string): PublicSkillLocation | null {
  const segments = id.split("/");
  if (segments.length !== 2) return null;
  const [folder, folderName] = segments;
  if (!folderName || !SAFE_SKILL_NAME_PATTERN.test(folderName)) return null;
  if (folder !== "tritonai" && folder !== "community") return null;
  return {
    id: `${folder}/${folderName}`,
    section: folder === "tritonai" ? "ai-team" : "community",
    folderName,
  };
}

function validateRelativeBundlePath(path: string): string | null {
  const normalized = path.replace(/\\/gu, "/");
  const parts = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    parts.length === 0 ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  return parts.join("/");
}

export const discoverPublicSkillCatalog = Effect.fn("discoverPublicSkillCatalog")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempRoot = yield* fs
    .makeTempDirectory({ prefix: "tritonai-public-skills-" })
    .pipe(
      Effect.mapError((cause) =>
        catalogError("A temporary public skills directory could not be created.", cause),
      ),
    );
  const repositoryPath = path.join(tempRoot, "repo");

  return yield* Effect.gen(function* () {
    const revision = yield* resolveMainRevision(tempRoot);
    yield* fs
      .makeDirectory(repositoryPath, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          catalogError("A temporary public skills repository could not be prepared.", cause),
        ),
      );
    yield* initializeRepository(repositoryPath, revision, catalogError);
    const tree = yield* listTree(repositoryPath, revision, ["tritonai", "community"], catalogError);
    const entrypoints = tree.filter((entry) => {
      const parts = entry.path.split("/");
      return parts.length === 3 && parts[2] === "SKILL.md";
    });
    const entries: ServerProviderSkillCatalogEntry[] = [];
    const names = new Set<string>();

    if (entrypoints.length > MAX_CATALOG_SKILLS) {
      return yield* catalogError("The public skills repository contains too many skills.");
    }

    for (const entrypoint of entrypoints) {
      const location = parsePublicSkillLocation(entrypoint.path.slice(0, -"/SKILL.md".length));
      if (!location) {
        return yield* catalogError(`Public skill path '${entrypoint.path}' is invalid.`);
      }
      if (entrypoint.type !== "blob" || entrypoint.mode === "120000" || entrypoint.size === null) {
        return yield* catalogError(`Public skill '${location.id}' has an invalid SKILL.md file.`);
      }
      const content = yield* readBlob(
        repositoryPath,
        entrypoint.object,
        entrypoint.size,
        catalogError,
      );
      const frontmatterBlock = extractFrontmatterBlock(content);
      if (!frontmatterBlock) {
        return yield* catalogError(`Public skill '${location.id}' has no YAML frontmatter.`);
      }
      const frontmatter = yield* decodePublicSkillFrontmatter(frontmatterBlock).pipe(
        Effect.mapError((error) =>
          catalogError(
            `Public skill '${location.id}' frontmatter is invalid: ${schemaIssue(error)}`,
            error,
          ),
        ),
      );
      const name = frontmatter.name.trim();
      const description = frontmatter.description.trim();
      const maintainer = frontmatter.maintainer?.trim();
      if (name !== location.folderName || !SAFE_SKILL_NAME_PATTERN.test(name) || !description) {
        return yield* catalogError(
          `Public skill '${location.id}' must have a matching safe name and a description.`,
        );
      }
      if (location.section === "community" && !maintainer) {
        return yield* catalogError(`Community skill '${location.id}' must declare a maintainer.`);
      }
      if (names.has(name)) {
        return yield* catalogError(`Public skill name '${name}' is duplicated.`);
      }
      names.add(name);
      entries.push({
        id: location.id,
        name,
        title: displayName(name),
        description,
        section: location.section,
        ...(maintainer ? { maintainer } : {}),
        revision,
        sourceUrl: `${PUBLIC_SKILLS_REPOSITORY_URL}/tree/${revision}/${location.id}`,
      });
    }

    return {
      version: 1,
      repositoryUrl: PUBLIC_SKILLS_REPOSITORY_URL,
      revision,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries.toSorted(
        (left, right) =>
          left.section.localeCompare(right.section) || left.title.localeCompare(right.title),
      ),
    } satisfies ServerProviderSkillCatalog;
  }).pipe(
    Effect.ensuring(fs.remove(tempRoot, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const loadPublicSkillBundle = Effect.fn("loadPublicSkillBundle")(function* (input: {
  readonly id: string;
  readonly revision: string;
}) {
  const location = parsePublicSkillLocation(input.id);
  if (!location) {
    return yield* installError("The selected public skill path is invalid.");
  }
  const revision = input.revision.trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(revision)) {
    return yield* installError("The selected public skill revision is invalid.");
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempRoot = yield* fs
    .makeTempDirectory({ prefix: "tritonai-public-skill-install-" })
    .pipe(
      Effect.mapError((cause) =>
        installError("A temporary public skill directory could not be created.", cause),
      ),
    );
  const repositoryPath = path.join(tempRoot, "repo");

  return yield* Effect.gen(function* () {
    yield* fs
      .makeDirectory(repositoryPath, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          installError("A temporary public skill repository could not be prepared.", cause),
        ),
      );
    yield* initializeRepository(repositoryPath, revision, installError);
    const tree = yield* listTree(repositoryPath, revision, [location.id], installError);
    if (tree.length === 0) {
      return yield* installError("The selected public skill was not found at that revision.");
    }
    if (tree.length > MAX_SKILL_FILE_COUNT) {
      return yield* installError("The selected public skill contains too many files.");
    }

    let totalBytes = 0;
    const files: ServerProviderSkillBundleFile[] = [];
    for (const entry of tree) {
      if (entry.type !== "blob" || entry.mode === "120000" || entry.size === null) {
        return yield* installError("Public skills cannot contain symlinks or non-file entries.");
      }
      const prefix = `${location.id}/`;
      if (!entry.path.startsWith(prefix)) {
        return yield* installError("The selected public skill contains an unsafe path.");
      }
      const relativePath = validateRelativeBundlePath(entry.path.slice(prefix.length));
      if (!relativePath) {
        return yield* installError(
          `The selected public skill contains an unsafe path: ${entry.path}`,
        );
      }
      totalBytes += entry.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SKILL_BYTES) {
        return yield* installError("The selected public skill is too large.");
      }
      files.push({
        path: relativePath,
        content: yield* readBlob(repositoryPath, entry.object, entry.size, installError),
      });
    }
    if (!files.some((file) => file.path === "SKILL.md")) {
      return yield* installError("The selected public skill has no root SKILL.md file.");
    }
    return {
      version: 1,
      skillId: location.folderName,
      files,
    } satisfies ServerProviderSkillBundle;
  }).pipe(
    Effect.ensuring(fs.remove(tempRoot, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});
