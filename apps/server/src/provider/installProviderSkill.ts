// @effect-diagnostics nodeBuiltinImport:off - lstat device/inode checks bind skill refreshes to the inspected directory.
import * as NodeFS from "node:fs";

import {
  type ProviderInstanceId,
  ServerInstallProviderSkillInput,
  type ServerInstallProviderSkillResult,
  ServerProviderSkillBundle,
  type ServerProviderSkillBundle as ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSkillBundleFile,
} from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  loadManagedSkillManifest,
  managedSkillManifestBlocksMutation,
} from "./managedSkillManifest.ts";
import { loadPublicSkillBundle } from "./publicSkillRepository.ts";

const GIT_CLONE_TIMEOUT_MS = 120_000;
const MAX_BUNDLE_FILE_COUNT = 200;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_INSTALL_SOURCE_BYTES = MAX_BUNDLE_BYTES + 512 * 1024;
const SAFE_SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

interface NormalizedGitHubUrl {
  readonly cloneUrl: string;
  readonly refAndPathSegments?: ReadonlyArray<string>;
}

const decodeSkillBundleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderSkillBundle),
);
const decodeInstallInput = Schema.decodeUnknownEffect(ServerInstallProviderSkillInput);
const isInstallError = Schema.is(ServerProviderSkillInstallError);

const SkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
});
const decodeSkillFrontmatter = Schema.decodeUnknownEffect(fromYaml(SkillFrontmatter));

interface SkillDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

const isMissingPathError = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const inspectSkillDirectoryIdentity = (
  skillDirectory: string,
): Effect.Effect<SkillDirectoryIdentity | null, ServerProviderSkillInstallError> =>
  Effect.try({
    try: () => {
      let stats: NodeFS.Stats;
      try {
        stats = NodeFS.lstatSync(skillDirectory);
      } catch (cause) {
        if (isMissingPathError(cause)) return null;
        throw cause;
      }
      if (!stats.isDirectory()) {
        throw new Error("The skill destination must remain a real directory.");
      }
      return { dev: stats.dev, ino: stats.ino };
    },
    catch: (cause) =>
      installError(`Failed to capture directory identity for ${skillDirectory}.`, cause),
  });

const verifySkillDirectoryIdentity = (
  skillDirectory: string,
  expected: SkillDirectoryIdentity,
): Effect.Effect<void, ServerProviderSkillInstallError> =>
  inspectSkillDirectoryIdentity(skillDirectory).pipe(
    Effect.flatMap((current) =>
      current !== null && current.dev === expected.dev && current.ino === expected.ino
        ? Effect.void
        : installError(`Refusing to refresh ${skillDirectory} after its identity changed.`),
    ),
    Effect.mapError((cause) =>
      cause.message.includes("identity changed")
        ? cause
        : installError(`Refusing to refresh ${skillDirectory} after its identity changed.`, cause),
    ),
  );

function schemaIssue(error: Schema.SchemaError): string {
  return SchemaIssue.makeFormatterDefault()(error.issue);
}

function installError(message: string, cause?: unknown) {
  return new ServerProviderSkillInstallError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const assertNotSymbolicLinkPath = Effect.fn("assertNotSymbolicLinkPath")(function* (
  targetPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const isSymbolicLink = yield* isSymbolicLinkPath(fs, targetPath).pipe(
    Effect.mapError((cause) =>
      installError(`Failed to inspect skill destination path ${targetPath}.`, cause),
    ),
  );
  if (isSymbolicLink) {
    return yield* installError(
      `Refusing to install a skill through symlinked destination path ${targetPath}.`,
    );
  }
});

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl.trim());
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function ensureHttpUrl(rawUrl: string): Effect.Effect<URL, ServerProviderSkillInstallError> {
  const parsed = parseUrl(rawUrl);
  if (!parsed) {
    return installError("Skill source must be an absolute HTTPS URL.");
  }
  if (parsed.protocol === "https:") {
    return Effect.succeed(parsed);
  }
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return Effect.succeed(parsed);
  }
  return installError(
    "Skill source must be an HTTPS URL. HTTP is only allowed for loopback development sources.",
  );
}

function fetchInstallText(
  url: string,
): Effect.Effect<string, ServerProviderSkillInstallError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader(
            "accept",
            "application/json, text/markdown;q=0.9, text/plain;q=0.8, */*;q=0.7",
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => readLimitedInstallText(url, response)),
        Effect.mapError((cause) =>
          isInstallError(cause)
            ? cause
            : installError(`Failed to fetch skill source from ${url}.`, cause),
        ),
      );
  });
}

function parseContentLengthHeader(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function installSourceTooLarge(url: string) {
  return installError(
    `Skill source from ${url} exceeds the ${MAX_INSTALL_SOURCE_BYTES} byte limit.`,
  );
}

function readLimitedInstallText(url: string, response: HttpClientResponse.HttpClientResponse) {
  const contentLength = parseContentLengthHeader(response.headers["content-length"]);
  if (contentLength !== null && contentLength > MAX_INSTALL_SOURCE_BYTES) {
    return installSourceTooLarge(url);
  }

  const decoder = new TextDecoder();
  return response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ bytes: 0, chunks: [] as string[] }),
      (state, chunk) => {
        const bytes = state.bytes + chunk.byteLength;
        if (bytes > MAX_INSTALL_SOURCE_BYTES) {
          return installSourceTooLarge(url);
        }
        state.chunks.push(decoder.decode(chunk, { stream: true }));
        return Effect.succeed({ bytes, chunks: state.chunks });
      },
    ),
    Effect.map((state) => {
      const tail = decoder.decode();
      return tail ? [...state.chunks, tail].join("") : state.chunks.join("");
    }),
  );
}

function bundleFromSkillMarkdown(
  skillId: string,
  content: string,
): Effect.Effect<ServerProviderSkillBundleData, ServerProviderSkillInstallError> {
  return validateSkillBundle({
    version: 1,
    skillId,
    files: [{ path: "SKILL.md", content }],
  });
}

function loadBundleFromUrl(
  url: string,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  HttpClient.HttpClient
> {
  return fetchInstallText(url).pipe(
    Effect.flatMap((raw) => {
      const trimmed = raw.trimStart();
      if (trimmed.startsWith("{")) {
        return decodeSkillBundleJson(raw).pipe(
          Effect.mapError((error) =>
            installError(`Skill bundle from ${url} was invalid: ${schemaIssue(error)}`, error),
          ),
          Effect.flatMap(validateSkillBundle),
        );
      }
      return bundleFromSkillMarkdown(url, raw);
    }),
  );
}

function loadBundleForCatalogEntry(
  catalogEntryId: string,
  revision: string,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  HttpClient.HttpClient
> {
  return loadPublicSkillBundle({ id: catalogEntryId, revision }).pipe(
    Effect.flatMap(validateSkillBundle),
    Effect.flatMap((bundle) => {
      const expectedName = catalogEntryId.split("/")[1];
      const entrypoint = bundle.files.find((file) => file.path.replace(/\\/gu, "/") === "SKILL.md");
      if (!expectedName || !entrypoint) {
        return installError("The selected public skill is invalid.");
      }
      return extractFrontmatter(entrypoint.content).pipe(
        Effect.flatMap((frontmatter) =>
          frontmatter.name === expectedName && bundle.skillId === expectedName
            ? Effect.succeed(bundle)
            : installError(`Public skill '${catalogEntryId}' does not match its SKILL.md name.`),
        ),
      );
    }),
  );
}

function normalizeGitHubUrl(rawUrl: string): NormalizedGitHubUrl | null {
  const parsed = parseUrl(rawUrl);
  if (!parsed || parsed.hostname.toLowerCase() !== "github.com") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, rawRepo] = segments;
  const repo = rawRepo?.replace(/\.git$/u, "");
  if (!owner || !repo) return null;

  const marker = segments[2];
  if ((marker === "tree" || marker === "blob") && segments[3]) {
    return {
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      refAndPathSegments: segments.slice(3),
    };
  }

  return {
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

function parseGitRemoteRefs(output: string): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const [, refName] = line.trim().split(/\s+/u);
    if (!refName || refName.endsWith("^{}")) continue;
    if (refName.startsWith("refs/heads/")) {
      refs.add(refName.slice("refs/heads/".length));
    }
    if (refName.startsWith("refs/tags/")) {
      refs.add(refName.slice("refs/tags/".length));
    }
  }
  return refs;
}

function resolveGitHubRefAndPath(input: {
  readonly refAndPathSegments: ReadonlyArray<string>;
  readonly remoteRefs: ReadonlySet<string>;
}): Effect.Effect<
  { readonly branch: string; readonly skillPath?: string },
  ServerProviderSkillInstallError
> {
  const segments = input.refAndPathSegments;
  for (let index = segments.length; index >= 1; index -= 1) {
    const candidate = segments.slice(0, index).join("/");
    if (input.remoteRefs.has(candidate)) {
      const skillPath = segments.slice(index).join("/");
      return Effect.succeed({
        branch: candidate,
        ...(skillPath ? { skillPath } : {}),
      });
    }
  }
  return installError(
    `Could not resolve GitHub branch or tag from '${segments.join("/")}'. Check the link and try again.`,
  );
}

function sanitizeSkillName(name: string): Effect.Effect<string, ServerProviderSkillInstallError> {
  const trimmed = name.trim();
  if (!SAFE_SKILL_NAME_PATTERN.test(trimmed) || trimmed === "." || trimmed === "..") {
    return installError(
      `Skill name '${name}' is not safe to install as a folder name. Use letters, numbers, dots, dashes, or underscores.`,
    );
  }
  return Effect.succeed(trimmed);
}

function validateBundlePath(
  relativePath: string,
): Effect.Effect<string, ServerProviderSkillInstallError> {
  const normalizedSeparators = relativePath.replace(/\\/gu, "/");
  const parts = normalizedSeparators.split("/").filter(Boolean);
  if (
    normalizedSeparators.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalizedSeparators) ||
    parts.length === 0 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    return installError(`Skill bundle contains an unsafe path: ${relativePath}`);
  }
  return Effect.succeed(parts.join("/"));
}

function extractFrontmatter(
  content: string,
): Effect.Effect<
  { readonly name: string; readonly description?: string },
  ServerProviderSkillInstallError
> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match?.[1]) {
    return installError("Skill entrypoint must start with YAML frontmatter.");
  }
  return decodeSkillFrontmatter(match[1]).pipe(
    Effect.mapError((error) =>
      installError(`Skill frontmatter is invalid: ${schemaIssue(error)}`, error),
    ),
    Effect.map((frontmatter) => ({
      name: frontmatter.name,
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
    })),
  );
}

function validateSkillBundle(
  bundle: ServerProviderSkillBundleData,
): Effect.Effect<ServerProviderSkillBundleData, ServerProviderSkillInstallError> {
  return Effect.gen(function* () {
    if (bundle.files.length === 0) {
      return yield* installError("Skill bundle contains no files.");
    }
    if (bundle.files.length > MAX_BUNDLE_FILE_COUNT) {
      return yield* installError("Skill bundle contains too many files.");
    }
    const totalBytes = bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    if (totalBytes > MAX_BUNDLE_BYTES) {
      return yield* installError("Skill bundle is too large.");
    }

    const seen = new Set<string>();
    const seenCaseInsensitive = new Set<string>();
    for (const file of bundle.files) {
      const normalized = yield* validateBundlePath(file.path);
      if (seen.has(normalized)) {
        return yield* installError(`Skill bundle contains a duplicate path: ${file.path}`);
      }
      const caseInsensitiveKey = normalized.toLowerCase();
      if (seenCaseInsensitive.has(caseInsensitiveKey)) {
        return yield* installError(
          `Skill bundle contains a case-only duplicate path: ${file.path}`,
        );
      }
      seen.add(normalized);
      seenCaseInsensitive.add(caseInsensitiveKey);
    }

    const entrypoint = bundle.files.find((file) => file.path.replace(/\\/gu, "/") === "SKILL.md");
    if (!entrypoint) {
      return yield* installError("Skill bundle must contain SKILL.md at its root.");
    }
    const frontmatter = yield* extractFrontmatter(entrypoint.content);
    yield* sanitizeSkillName(frontmatter.name);
    return bundle;
  });
}

function normalizeRequestedSkillPath(
  requestedPath: string,
): Effect.Effect<string, ServerProviderSkillInstallError> {
  const normalizedSeparators = requestedPath.replace(/\\/gu, "/");
  const parts = normalizedSeparators.split("/").filter(Boolean);
  if (
    normalizedSeparators.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalizedSeparators) ||
    parts.length === 0 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    return installError("GitHub skill path is unsafe.");
  }
  return Effect.succeed(parts.join("/"));
}

function candidateSkillDirectoryFromPath(
  requestedPath: string,
): Effect.Effect<string, ServerProviderSkillInstallError> {
  return normalizeRequestedSkillPath(requestedPath).pipe(
    Effect.map((normalized) =>
      normalized.endsWith("/SKILL.md")
        ? normalized.slice(0, -"/SKILL.md".length)
        : normalized === "SKILL.md"
          ? "."
          : normalized,
    ),
  );
}

function findSkillDirectory(
  root: string,
  requestedPath?: string,
): Effect.Effect<string, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    if (requestedPath) {
      const normalized = yield* normalizeRequestedSkillPath(requestedPath);
      const requestedAbsolute = pathService.join(root, normalized);
      const candidateDirectory =
        pathService.basename(requestedAbsolute) === "SKILL.md"
          ? pathService.dirname(requestedAbsolute)
          : requestedAbsolute;
      const exists = yield* fs
        .exists(pathService.join(candidateDirectory, "SKILL.md"))
        .pipe(
          Effect.mapError((cause) =>
            installError("Failed to inspect the requested GitHub skill path.", cause),
          ),
        );
      if (!exists) {
        return yield* installError("The GitHub path does not contain a SKILL.md file.");
      }
      return candidateDirectory;
    }

    const rootSkill = pathService.join(root, "SKILL.md");
    if (
      yield* fs
        .exists(rootSkill)
        .pipe(
          Effect.mapError((cause) =>
            installError("Failed to inspect the GitHub repository root.", cause),
          ),
        )
    ) {
      return root;
    }

    const skillsDir = pathService.join(root, "skills");
    const skillDirectories: string[] = [];
    const hasSkillsDir = yield* fs
      .exists(skillsDir)
      .pipe(
        Effect.mapError((cause) =>
          installError("Failed to inspect the GitHub repository skills directory.", cause),
        ),
      );
    if (hasSkillsDir) {
      const entries = yield* fs
        .readDirectory(skillsDir, { recursive: false })
        .pipe(
          Effect.mapError((cause) =>
            installError("Failed to read the GitHub repository skills directory.", cause),
          ),
        );
      for (const entry of entries) {
        const candidate = pathService.join(skillsDir, entry);
        const info = yield* fs.stat(candidate).pipe(Effect.option);
        if (info._tag === "Some" && info.value.type === "Directory") {
          const hasEntrypoint = yield* fs
            .exists(pathService.join(candidate, "SKILL.md"))
            .pipe(
              Effect.mapError((cause) =>
                installError("Failed to inspect a GitHub skill directory.", cause),
              ),
            );
          if (hasEntrypoint) {
            skillDirectories.push(candidate);
          }
        }
      }
    }

    if (skillDirectories.length === 1) {
      return skillDirectories[0]!;
    }
    if (skillDirectories.length > 1) {
      return yield* installError(
        "The GitHub repository contains multiple skills. Link directly to one skill folder.",
      );
    }

    return yield* installError("The GitHub repository does not contain a SKILL.md file.");
  });
}

function parseGitSkillEntrypoints(output: string): {
  readonly rootSkill: boolean;
  readonly skillDirectories: ReadonlyArray<string>;
} {
  const skillDirectories = new Set<string>();
  let rootSkill = false;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "SKILL.md") {
      rootSkill = true;
      continue;
    }
    const match = /^skills\/([^/]+)\/SKILL\.md$/u.exec(line);
    if (match) {
      skillDirectories.add(`skills/${match[1]}`);
    }
  }
  return { rootSkill, skillDirectories: [...skillDirectories].toSorted() };
}

function discoverGitSkillCheckoutPath(
  repositoryPath: string,
): Effect.Effect<string | undefined, ServerProviderSkillInstallError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const output = yield* process
      .run({
        operation: "installProviderSkill.gitListSkillEntrypoints",
        command: "git",
        args: [
          "-C",
          repositoryPath,
          "ls-tree",
          "-r",
          "--name-only",
          "HEAD",
          "--",
          "SKILL.md",
          "skills",
        ],
        cwd: repositoryPath,
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
        maxOutputBytes: 512 * 1024,
      })
      .pipe(
        Effect.mapError((cause) =>
          installError("Failed to inspect GitHub skill source tree.", cause),
        ),
      );
    const entrypoints = parseGitSkillEntrypoints(output.stdout);
    if (entrypoints.rootSkill) {
      return undefined;
    }
    if (entrypoints.skillDirectories.length === 1) {
      return entrypoints.skillDirectories[0];
    }
    if (entrypoints.skillDirectories.length > 1) {
      return yield* installError(
        "The GitHub repository contains multiple skills. Link directly to one skill folder.",
      );
    }
    return yield* installError("The GitHub repository does not contain a SKILL.md file.");
  });
}

function checkoutGitSkillPath(input: {
  readonly repositoryPath: string;
  readonly checkoutPath?: string;
}): Effect.Effect<void, ServerProviderSkillInstallError, VcsProcess.VcsProcess> {
  const checkoutPath = input.checkoutPath;
  if (!checkoutPath || checkoutPath === ".") {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    yield* process
      .run({
        operation: "installProviderSkill.gitSparseCheckout",
        command: "git",
        args: ["-C", input.repositoryPath, "sparse-checkout", "set", checkoutPath],
        cwd: input.repositoryPath,
        timeoutMs: GIT_CLONE_TIMEOUT_MS,
        maxOutputBytes: 256 * 1024,
      })
      .pipe(
        Effect.mapError((cause) =>
          installError("Failed to check out the requested GitHub skill path.", cause),
        ),
      );
  });
}

function isSymbolicLinkPath(
  fs: FileSystem.FileSystem,
  absolutePath: string,
): Effect.Effect<boolean, PlatformError.PlatformError> {
  return fs.readLink(absolutePath).pipe(
    Effect.as(true),
    Effect.catchTags({
      PlatformError: (cause) => {
        const nodeCause = cause.reason.cause;
        const isRegularPath =
          cause.reason._tag === "Unknown" &&
          typeof nodeCause === "object" &&
          nodeCause !== null &&
          "code" in nodeCause &&
          nodeCause.code === "EINVAL";
        return cause.reason._tag === "NotFound" || isRegularPath
          ? Effect.succeed(false)
          : Effect.fail(cause);
      },
    }),
  );
}

function readSkillDirectoryBundle(
  skillDirectory: string,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const files: ServerProviderSkillBundleFile[] = [];
    let totalBytes = 0n;
    const maxBundleBytes = BigInt(MAX_BUNDLE_BYTES);

    if (
      yield* isSymbolicLinkPath(fs, skillDirectory).pipe(
        Effect.mapError((cause) =>
          installError(`Failed to inspect GitHub skill path '${skillDirectory}'.`, cause),
        ),
      )
    ) {
      return yield* installError("GitHub skill path must point to a real directory.");
    }
    const rootInfo = yield* fs
      .stat(skillDirectory)
      .pipe(Effect.mapError((cause) => installError(`Failed to stat '${skillDirectory}'.`, cause)));
    if (rootInfo.type !== "Directory") {
      return yield* installError("GitHub skill path must point to a real directory.");
    }

    const walk = Effect.fn("readSkillDirectoryBundle.walk")(function* (
      currentDirectory: string,
      relativePrefix: string,
    ): Effect.fn.Return<void, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
      const entries = yield* fs
        .readDirectory(currentDirectory, { recursive: false })
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to read skill directory '${currentDirectory}'.`, cause),
          ),
        );
      for (const entry of entries.toSorted()) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const absolutePath = pathService.join(currentDirectory, entry);
        const relativePath = relativePrefix ? `${relativePrefix}/${entry}` : entry;
        if (
          yield* isSymbolicLinkPath(fs, absolutePath).pipe(
            Effect.mapError((cause) =>
              installError(`Failed to inspect GitHub skill path '${absolutePath}'.`, cause),
            ),
          )
        )
          continue;
        const info = yield* fs
          .stat(absolutePath)
          .pipe(
            Effect.mapError((cause) => installError(`Failed to stat '${absolutePath}'.`, cause)),
          );
        if (info.type === "Directory") {
          yield* walk(absolutePath, relativePath);
          continue;
        }
        if (info.type !== "File") continue;
        if (files.length + 1 > MAX_BUNDLE_FILE_COUNT) {
          return yield* installError("Skill bundle contains too many files.");
        }
        const statSize = BigInt(info.size);
        if (totalBytes + statSize > maxBundleBytes) {
          return yield* installError("Skill bundle is too large.");
        }
        const content = yield* fs
          .readFileString(absolutePath)
          .pipe(
            Effect.mapError((cause) => installError(`Failed to read '${absolutePath}'.`, cause)),
          );
        totalBytes += BigInt(Buffer.byteLength(content));
        if (totalBytes > maxBundleBytes) {
          return yield* installError("Skill bundle is too large.");
        }
        files.push({ path: relativePath, content });
      }
    });

    yield* walk(skillDirectory, "");
    const entrypoint = files.find((file) => file.path === "SKILL.md");
    if (!entrypoint) {
      return yield* installError("Skill directory does not contain SKILL.md at its root.");
    }
    const frontmatter = yield* extractFrontmatter(entrypoint.content);
    const skillName = yield* sanitizeSkillName(frontmatter.name);
    return yield* validateSkillBundle({
      version: 1,
      skillId: skillName,
      files,
    });
  });
}

function cloneGitHubSkillBundle(
  normalized: NormalizedGitHubUrl,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const tempRoot = yield* fs
      .makeTempDirectory({ prefix: "t3-skill-install-" })
      .pipe(
        Effect.mapError((cause) =>
          installError("Failed to create a temporary GitHub skill clone directory.", cause),
        ),
      );
    const destination = pathService.join(tempRoot, "repo");
    return yield* Effect.gen(function* () {
      const resolvedRef = normalized.refAndPathSegments
        ? yield* process
            .run({
              operation: "installProviderSkill.gitLsRemote",
              command: "git",
              args: ["ls-remote", "--heads", "--tags", normalized.cloneUrl],
              cwd: tempRoot,
              timeoutMs: GIT_CLONE_TIMEOUT_MS,
              maxOutputBytes: 512 * 1024,
            })
            .pipe(
              Effect.map((output) => parseGitRemoteRefs(output.stdout)),
              Effect.flatMap((remoteRefs) =>
                resolveGitHubRefAndPath({
                  refAndPathSegments: normalized.refAndPathSegments!,
                  remoteRefs,
                }),
              ),
              Effect.mapError((cause) =>
                installError("Failed to resolve GitHub skill source branch.", cause),
              ),
            )
        : undefined;
      const cloneArgs = [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        ...(resolvedRef ? ["--branch", resolvedRef.branch] : []),
        normalized.cloneUrl,
        destination,
      ];

      yield* process
        .run({
          operation: "installProviderSkill.gitClone",
          command: "git",
          args: cloneArgs,
          cwd: tempRoot,
          timeoutMs: GIT_CLONE_TIMEOUT_MS,
          maxOutputBytes: 256 * 1024,
        })
        .pipe(
          Effect.mapError((cause) => installError("Failed to clone GitHub skill source.", cause)),
        );

      const checkoutPath = resolvedRef?.skillPath
        ? yield* candidateSkillDirectoryFromPath(resolvedRef.skillPath)
        : yield* discoverGitSkillCheckoutPath(destination);
      yield* checkoutGitSkillPath({
        repositoryPath: destination,
        ...(checkoutPath !== undefined ? { checkoutPath } : {}),
      });
      const skillDirectory = yield* findSkillDirectory(
        destination,
        checkoutPath === "." ? undefined : checkoutPath,
      );
      return yield* readSkillDirectoryBundle(skillDirectory);
    }).pipe(
      Effect.ensuring(
        fs.remove(tempRoot, { recursive: true }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
  });
}

function loadBundleForUrl(
  rawUrl: string,
): Effect.Effect<
  ServerProviderSkillBundleData,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | VcsProcess.VcsProcess
> {
  return Effect.gen(function* () {
    const url = yield* ensureHttpUrl(rawUrl);
    const github = normalizeGitHubUrl(url.toString());
    if (github) {
      return yield* cloneGitHubSkillBundle(github);
    }

    return yield* loadBundleFromUrl(url.toString());
  });
}

export function installSkillBundle(input: {
  readonly bundle: ServerProviderSkillBundleData;
  readonly skillsDirectory: string;
}): Effect.Effect<
  {
    readonly skillName: string;
    readonly skillPath: string;
    readonly rollback: ProviderSkillInstallRollback;
  },
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const bundle = yield* validateSkillBundle(input.bundle);
    const entrypoint = bundle.files.find((file) => file.path.replace(/\\/gu, "/") === "SKILL.md");
    if (!entrypoint) {
      return yield* installError("Skill bundle must contain SKILL.md at its root.");
    }

    const frontmatter = yield* extractFrontmatter(entrypoint.content);
    const skillName = yield* sanitizeSkillName(frontmatter.name);
    const skillsDirectory = pathService.resolve(input.skillsDirectory);
    yield* assertNotSymbolicLinkPath(skillsDirectory);
    const skillDirectory = pathService.join(skillsDirectory, skillName);
    const skillPath = pathService.join(skillDirectory, "SKILL.md");

    const managed = yield* loadManagedSkillManifest(skillsDirectory);
    if (managedSkillManifestBlocksMutation(managed.status)) {
      return yield* installError(
        `Skill '${skillName}' cannot be installed while TritonAI managed-skill ownership cannot be verified. Run the Installer to repair the manifest first.`,
      );
    }
    if (managed.status === "valid" && managed.skillNames.includes(skillName)) {
      return yield* installError(
        `Skill '${skillName}' is managed by the TritonAI Installer and cannot be replaced here.`,
      );
    }

    yield* assertNotSymbolicLinkPath(skillDirectory);

    const existingSkillDirectoryIdentity = yield* inspectSkillDirectoryIdentity(skillDirectory);
    if (existingSkillDirectoryIdentity !== null) {
      const existingEntrypoint = yield* fs
        .exists(skillPath)
        .pipe(Effect.mapError((cause) => installError(`Failed to inspect ${skillPath}.`, cause)));
      if (!existingEntrypoint) {
        return yield* installError(
          `Skill '${skillName}' cannot be installed because ${skillDirectory} already exists without a SKILL.md file.`,
        );
      }

      const existingContent = yield* fs
        .readFileString(skillPath)
        .pipe(Effect.mapError((cause) => installError(`Failed to read ${skillPath}.`, cause)));
      const existingFrontmatter = yield* extractFrontmatter(existingContent);
      if (existingFrontmatter.name !== skillName) {
        return yield* installError(
          `Skill '${skillName}' cannot be installed because ${skillDirectory} already contains skill '${existingFrontmatter.name}'.`,
        );
      }

      yield* verifySkillDirectoryIdentity(skillDirectory, existingSkillDirectoryIdentity);
      const rollback = yield* refreshExistingSkillBundleFiles({
        expectedSkillDirectoryIdentity: existingSkillDirectoryIdentity,
        files: bundle.files,
        skillDirectory,
      });
      return { skillName, skillPath, rollback };
    }

    yield* fs
      .makeDirectory(skillsDirectory, { recursive: true })
      .pipe(
        Effect.mapError((cause) => installError(`Failed to create ${skillsDirectory}.`, cause)),
      );
    yield* assertNotSymbolicLinkPath(skillsDirectory);
    const stagingRoot = yield* prepareSkillBundleDirectory({
      files: bundle.files,
      parentDirectory: skillsDirectory,
      prefix: `.${skillName}.install.`,
    });
    let claimedIdentity: SkillDirectoryIdentity | null = null;
    yield* Effect.gen(function* () {
      yield* assertNotSymbolicLinkPath(skillsDirectory);
      yield* fs
        .makeDirectory(skillDirectory, { mode: 0o700 })
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to claim new skill destination ${skillDirectory}.`, cause),
          ),
        );
      claimedIdentity = yield* inspectSkillDirectoryIdentity(skillDirectory);
      if (claimedIdentity === null) {
        return yield* installError(`Failed to claim new skill destination ${skillDirectory}.`);
      }

      const stagedEntries = yield* fs
        .readDirectory(stagingRoot.skillDirectory)
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to inspect staged skill ${stagingRoot.skillDirectory}.`, cause),
          ),
        );
      stagedEntries.sort((left, right) => {
        if (left === "SKILL.md") return 1;
        if (right === "SKILL.md") return -1;
        return left < right ? -1 : left > right ? 1 : 0;
      });
      for (const entry of stagedEntries) {
        yield* verifySkillDirectoryIdentity(skillDirectory, claimedIdentity);
        yield* fs
          .rename(
            pathService.join(stagingRoot.skillDirectory, entry),
            pathService.join(skillDirectory, entry),
          )
          .pipe(
            Effect.mapError((cause) => installError(`Failed to publish ${skillDirectory}.`, cause)),
          );
      }
      yield* verifySkillDirectoryIdentity(skillDirectory, claimedIdentity);
    }).pipe(
      Effect.catch((error) =>
        claimedIdentity === null
          ? Effect.fail(error)
          : inspectSkillDirectoryIdentity(skillDirectory).pipe(
              Effect.flatMap((current) =>
                current !== null &&
                current.dev === claimedIdentity?.dev &&
                current.ino === claimedIdentity.ino
                  ? fs.remove(skillDirectory, { recursive: true, force: true })
                  : Effect.void,
              ),
              Effect.catch(() => Effect.void),
              Effect.andThen(Effect.fail(error)),
            ),
      ),
      Effect.ensuring(
        fs.remove(stagingRoot.root, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    if (claimedIdentity === null) {
      return yield* installError(`Failed to retain new skill destination ${skillDirectory}.`);
    }

    return {
      skillName,
      skillPath,
      rollback: {
        _tag: "remove",
        skillDirectoryPath: skillDirectory,
        expectedSkillDirectoryIdentity: claimedIdentity,
      },
    };
  });
}

export type ProviderSkillInstallRollback =
  | {
      readonly _tag: "remove";
      readonly skillDirectoryPath: string;
      readonly expectedSkillDirectoryIdentity: SkillDirectoryIdentity;
    }
  | {
      readonly _tag: "restore";
      readonly skillDirectoryPath: string;
      readonly backupRootPath: string;
      readonly backupDirectoryPath: string;
    };

function writeSkillBundleFiles(input: {
  readonly files: ReadonlyArray<ServerProviderSkillBundleFile>;
  readonly skillDirectory: string;
}): Effect.Effect<void, ServerProviderSkillInstallError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    for (const file of input.files) {
      const normalizedPath = yield* validateBundlePath(file.path);
      const targetPath = pathService.join(input.skillDirectory, normalizedPath);
      yield* fs
        .makeDirectory(pathService.dirname(targetPath), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to create directory for ${targetPath}.`, cause),
          ),
        );
      yield* fs
        .writeFileString(targetPath, file.content)
        .pipe(Effect.mapError((cause) => installError(`Failed to write ${targetPath}.`, cause)));
    }
  });
}

function prepareSkillBundleDirectory(input: {
  readonly files: ReadonlyArray<ServerProviderSkillBundleFile>;
  readonly parentDirectory: string;
  readonly prefix: string;
}): Effect.Effect<
  { readonly root: string; readonly skillDirectory: string },
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const root = yield* fs
      .makeTempDirectory({
        directory: input.parentDirectory,
        prefix: input.prefix,
      })
      .pipe(
        Effect.mapError((cause) =>
          installError(
            `Failed to prepare a skill staging directory in ${input.parentDirectory}.`,
            cause,
          ),
        ),
      );
    const skillDirectory = pathService.join(root, "skill");
    return yield* Effect.gen(function* () {
      yield* fs
        .makeDirectory(skillDirectory)
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to create skill staging directory ${skillDirectory}.`, cause),
          ),
        );
      yield* writeSkillBundleFiles({ files: input.files, skillDirectory });
      return { root, skillDirectory } as const;
    }).pipe(
      Effect.catch((error) =>
        fs
          .remove(root, { recursive: true, force: true })
          .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
      ),
    );
  });
}

function refreshExistingSkillBundleFiles(input: {
  readonly expectedSkillDirectoryIdentity: SkillDirectoryIdentity;
  readonly files: ReadonlyArray<ServerProviderSkillBundleFile>;
  readonly skillDirectory: string;
}): Effect.Effect<
  ProviderSkillInstallRollback,
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const parentDirectory = pathService.dirname(input.skillDirectory);
    const backupRoot = yield* fs
      .makeTempDirectory({
        directory: parentDirectory,
        prefix: `${pathService.basename(input.skillDirectory)}.backup.`,
      })
      .pipe(
        Effect.mapError((cause) =>
          installError(`Failed to prepare backup for ${input.skillDirectory}.`, cause),
        ),
      );
    const backupDirectory = pathService.join(backupRoot, "skill");
    const replacementDirectory = pathService.join(backupRoot, "replacement");
    yield* fs
      .makeDirectory(replacementDirectory)
      .pipe(
        Effect.mapError((cause) =>
          installError(`Failed to prepare replacement for ${input.skillDirectory}.`, cause),
        ),
      );
    yield* writeSkillBundleFiles({
      files: input.files,
      skillDirectory: replacementDirectory,
    });

    let originalMoved = false;
    let replacementPublished = false;
    yield* Effect.gen(function* () {
      yield* verifySkillDirectoryIdentity(
        input.skillDirectory,
        input.expectedSkillDirectoryIdentity,
      );
      yield* fs
        .rename(input.skillDirectory, backupDirectory)
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to move ${input.skillDirectory} into its backup.`, cause),
          ),
        );
      originalMoved = true;
      yield* assertNotSymbolicLinkPath(backupDirectory);
      yield* verifySkillDirectoryIdentity(backupDirectory, input.expectedSkillDirectoryIdentity);
      yield* fs
        .rename(replacementDirectory, input.skillDirectory)
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to publish replacement for ${input.skillDirectory}.`, cause),
          ),
        );
      replacementPublished = true;
    }).pipe(
      Effect.catch((error) =>
        originalMoved && !replacementPublished
          ? fs.exists(input.skillDirectory).pipe(
              Effect.mapError((cause) =>
                installError(`Failed to inspect ${input.skillDirectory} during recovery.`, cause),
              ),
              Effect.flatMap((destinationExists) =>
                destinationExists
                  ? Effect.void
                  : fs
                      .rename(backupDirectory, input.skillDirectory)
                      .pipe(
                        Effect.andThen(fs.remove(backupRoot, { recursive: true, force: true })),
                        Effect.ignore,
                      ),
              ),
              Effect.andThen(Effect.fail(error)),
            )
          : Effect.fail(error),
      ),
    );

    return {
      _tag: "restore",
      skillDirectoryPath: input.skillDirectory,
      backupRootPath: backupRoot,
      backupDirectoryPath: backupDirectory,
    };
  });
}

export function rollbackProviderSkillInstall(
  rollback: ProviderSkillInstallRollback,
): Effect.Effect<void, ServerProviderSkillInstallError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (rollback._tag === "remove") {
      yield* verifySkillDirectoryIdentity(
        rollback.skillDirectoryPath,
        rollback.expectedSkillDirectoryIdentity,
      );
      yield* fs
        .remove(rollback.skillDirectoryPath, { recursive: true, force: true })
        .pipe(
          Effect.mapError((cause) =>
            installError(`Failed to roll back ${rollback.skillDirectoryPath}.`, cause),
          ),
        );
      return;
    }

    yield* fs
      .remove(rollback.skillDirectoryPath, { recursive: true, force: true })
      .pipe(
        Effect.mapError((cause) =>
          installError(`Failed to clear ${rollback.skillDirectoryPath} for rollback.`, cause),
        ),
      );
    yield* fs
      .copy(rollback.backupDirectoryPath, rollback.skillDirectoryPath, { overwrite: true })
      .pipe(
        Effect.mapError((cause) =>
          installError(`Failed to restore ${rollback.skillDirectoryPath}.`, cause),
        ),
      );
    yield* discardProviderSkillInstallRollback(rollback);
  });
}

export function discardProviderSkillInstallRollback(
  rollback: ProviderSkillInstallRollback,
): Effect.Effect<void, ServerProviderSkillInstallError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (rollback._tag === "remove") {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .remove(rollback.backupRootPath, { recursive: true, force: true })
      .pipe(
        Effect.mapError((cause) =>
          installError(`Failed to clean up ${rollback.backupRootPath}.`, cause),
        ),
      );
  });
}

export function mergeInstalledProviderSkill(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly skillName: string;
  readonly skillPath: string;
}): ReadonlyArray<ServerProvider> {
  return input.providers.map((provider) => {
    if (provider.instanceId !== input.instanceId) {
      return provider;
    }

    const alreadyPresent = provider.skills.some(
      (skill) => skill.path === input.skillPath || skill.name === input.skillName,
    );
    const installedSkill: ServerProviderSkill = {
      name: input.skillName,
      path: input.skillPath,
      enabled: true,
      scope: "user",
    };

    return {
      ...provider,
      skills: (alreadyPresent
        ? provider.skills.map((skill) =>
            skill.path === input.skillPath || skill.name === input.skillName
              ? {
                  ...skill,
                  name: input.skillName,
                  path: input.skillPath,
                  enabled: true,
                  scope: skill.scope ?? "user",
                }
              : skill,
          )
        : [...provider.skills, installedSkill]
      ).toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  });
}

export const installProviderSkill = Effect.fn("installProviderSkill")(function* (input: {
  readonly request: unknown;
  readonly skillsDirectory: string;
}): Effect.fn.Return<
  Omit<ServerInstallProviderSkillResult, "providers"> & {
    readonly rollback: ProviderSkillInstallRollback;
  },
  ServerProviderSkillInstallError,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | VcsProcess.VcsProcess
> {
  const request = yield* decodeInstallInput(input.request).pipe(
    Effect.mapError((error) =>
      installError(`Skill install request is invalid: ${schemaIssue(error)}`, error),
    ),
  );
  const bundle =
    request.source.type === "catalog"
      ? yield* loadBundleForCatalogEntry(request.source.catalogEntryId, request.source.revision)
      : yield* loadBundleForUrl(request.source.url);
  return yield* installSkillBundle({
    bundle,
    skillsDirectory: input.skillsDirectory,
  });
});
