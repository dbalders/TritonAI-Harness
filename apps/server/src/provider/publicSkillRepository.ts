import {
  type ServerProviderSkillBundle,
  type ServerProviderSkillBundleFile,
  type ServerProviderSkillCatalog,
  type ServerProviderSkillCatalogEntry,
  ServerProviderSkillCatalogError,
  ServerProviderSkillInstallError,
} from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const PUBLIC_SKILLS_REPOSITORY_URL = "https://github.com/dbalders/UCSD-Skills-Library";
const PUBLIC_SKILLS_API_URL = "https://api.github.com/repos/dbalders/UCSD-Skills-Library";
const PUBLIC_SKILLS_RAW_URL = "https://raw.githubusercontent.com/dbalders/UCSD-Skills-Library";
const PUBLIC_SKILLS_DEFAULT_BRANCH = "main";
const MAX_CATALOG_SKILLS = 200;
const MAX_SKILL_FILE_COUNT = 200;
const MAX_SKILL_BYTES = 2 * 1024 * 1024;
const MAX_GITHUB_METADATA_BYTES = 2 * 1024 * 1024;
const PUBLIC_SKILLS_REQUEST_TIMEOUT = "15 seconds";
const PUBLIC_SKILLS_CATALOG_TTL = "5 minutes";
const PUBLIC_SKILLS_RATE_LIMIT_COOLDOWN = "1 minute";
const PUBLIC_SKILLS_MAX_RATE_LIMIT_COOLDOWN = "1 hour";
const PUBLIC_SKILLS_COMMIT_CACHE_CAPACITY = 128;
const PUBLIC_SKILLS_TREE_CACHE_CAPACITY = 64;
const PUBLIC_SKILLS_CONTENT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const PUBLIC_SKILLS_CONTENT_CACHE_CAPACITY = Math.max(
  1,
  Math.floor(PUBLIC_SKILLS_CONTENT_CACHE_MAX_BYTES / MAX_SKILL_BYTES),
);
const PUBLIC_SKILLS_GITHUB_TOKEN_ENV = "TRITONAI_PUBLIC_SKILLS_GITHUB_TOKEN";
const SAFE_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

const PublicSkillFrontmatter = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  maintainer: Schema.optional(Schema.String),
});
const decodePublicSkillFrontmatter = Schema.decodeUnknownEffect(fromYaml(PublicSkillFrontmatter));

const GitHubCommitResponse = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    tree: Schema.Struct({ sha: Schema.String }),
  }),
});
const decodeGitHubCommitResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitHubCommitResponse),
);

const GitHubTreeResponse = Schema.Struct({
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({
      mode: Schema.String,
      type: Schema.String,
      sha: Schema.String,
      size: Schema.optional(Schema.Number),
      path: Schema.String,
    }),
  ),
});
const decodeGitHubTreeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitHubTreeResponse),
);
type GitHubTree = typeof GitHubTreeResponse.Type;

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

interface ResolvedRevision {
  readonly revision: string;
  readonly tree: string;
}

interface PublicSkillFetchRuntime {
  readonly httpClient: HttpClient.HttpClient;
  readonly githubToken: Redacted.Redacted<string> | undefined;
  readonly cooldownUntil: Ref.Ref<number>;
  readonly defaultCooldownMs: number;
}

class PublicSkillRepositoryFailure extends Error {
  readonly detail: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "PublicSkillRepositoryFailure";
    this.detail = detail;
  }
}

function repositoryError(message: string, cause?: unknown) {
  return new PublicSkillRepositoryFailure(message, cause);
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

function parseContentLengthHeader(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function readLimitedText<E>(
  response: HttpClientResponse.HttpClientResponse,
  maxBytes: number,
  errorFactory: (message: string, cause?: unknown) => E,
  failureMessage: string,
  tooLargeMessage: string,
): Effect.Effect<string, E> {
  const contentLength = parseContentLengthHeader(response.headers["content-length"]);
  if (contentLength !== null && contentLength > maxBytes) {
    return Effect.fail(errorFactory(tooLargeMessage));
  }

  const decoder = new TextDecoder();
  return response.stream.pipe(
    Stream.mapError((cause) => errorFactory(failureMessage, cause)),
    Stream.runFoldEffect(
      () => ({ bytes: 0, chunks: [] as string[] }),
      (state, chunk) => {
        const bytes = state.bytes + chunk.byteLength;
        if (bytes > maxBytes) {
          return Effect.fail(errorFactory(tooLargeMessage));
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

function rateLimitCooldownUntil(
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
  defaultCooldownMs: number,
): number {
  const retryAfter = headers["retry-after"]?.trim();
  let requestedUntil = now + defaultCooldownMs;
  if (retryAfter && /^\d+$/u.test(retryAfter)) {
    requestedUntil = now + Number(retryAfter) * 1_000;
  } else if (retryAfter) {
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed)) requestedUntil = parsed;
  } else {
    const reset = headers["x-ratelimit-reset"]?.trim();
    if (reset && /^\d+$/u.test(reset)) requestedUntil = Number(reset) * 1_000;
  }
  return Math.max(
    now + 1_000,
    Math.min(requestedUntil, now + Duration.toMillis(PUBLIC_SKILLS_MAX_RATE_LIMIT_COOLDOWN)),
  );
}

function fetchPublicSkillText<E>(
  runtime: PublicSkillFetchRuntime,
  input: {
    readonly url: string;
    readonly api: boolean;
    readonly accept: string;
    readonly maxBytes: number;
    readonly failureMessage: string;
    readonly tooLargeMessage: string;
    readonly errorFactory: (message: string, cause?: unknown) => E;
  },
): Effect.Effect<string, E> {
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (input.api && (yield* Ref.get(runtime.cooldownUntil)) > now) {
      return yield* Effect.fail(
        input.errorFactory(`${input.failureMessage} GitHub rate-limit cooldown is active.`),
      );
    }

    let request = HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.setHeader("accept", input.accept),
      HttpClientRequest.setHeader("user-agent", "TritonAI-Harness"),
    );
    if (input.api && runtime.githubToken) {
      request = request.pipe(HttpClientRequest.bearerToken(Redacted.value(runtime.githubToken)));
    }

    const response = yield* runtime.httpClient
      .execute(request)
      .pipe(Effect.mapError((cause) => input.errorFactory(input.failureMessage, cause)));
    if (
      input.api &&
      (response.status === 429 ||
        (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0"))
    ) {
      const until = rateLimitCooldownUntil(response.headers, now, runtime.defaultCooldownMs);
      yield* Ref.update(runtime.cooldownUntil, (current) => Math.max(current, until));
      yield* Stream.runDrain(response.stream).pipe(Effect.ignore);
      return yield* Effect.fail(
        input.errorFactory(`${input.failureMessage} GitHub rate limit was reached.`),
      );
    }
    const successfulResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.mapError((cause) => input.errorFactory(input.failureMessage, cause)),
    );
    return yield* readLimitedText(
      successfulResponse,
      input.maxBytes,
      input.errorFactory,
      input.failureMessage,
      input.tooLargeMessage,
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: PUBLIC_SKILLS_REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(
          input.errorFactory(
            `${input.failureMessage} Request timed out.`,
            new Error("The GitHub request timed out."),
          ),
        ),
    }),
  );
}

function resolveRevision<E>(
  runtime: PublicSkillFetchRuntime,
  revision: string,
  errorFactory: (message: string, cause?: unknown) => E,
): Effect.Effect<ResolvedRevision, E> {
  return Effect.gen(function* () {
    const raw = yield* fetchPublicSkillText(runtime, {
      url: `${PUBLIC_SKILLS_API_URL}/commits/${encodeURIComponent(revision)}`,
      api: true,
      accept: "application/vnd.github+json",
      maxBytes: 256 * 1024,
      failureMessage: "The public skills repository could not be reached.",
      tooLargeMessage: "The public skills repository revision response was too large.",
      errorFactory,
    });
    const response = yield* decodeGitHubCommitResponse(raw).pipe(
      Effect.mapError((cause) =>
        errorFactory("The public skills repository returned invalid revision metadata.", cause),
      ),
    );
    const resolvedRevision = response.sha.toLowerCase();
    const tree = response.commit.tree.sha.toLowerCase();
    if (!GIT_SHA_PATTERN.test(resolvedRevision) || !GIT_SHA_PATTERN.test(tree)) {
      return yield* Effect.fail(
        errorFactory("The public skills repository returned an invalid revision."),
      );
    }
    return { revision: resolvedRevision, tree };
  });
}

function loadTree<E>(
  runtime: PublicSkillFetchRuntime,
  treeSha: string,
  revision: string,
  errorFactory: (message: string, cause?: unknown) => E,
): Effect.Effect<GitHubTree, E> {
  return Effect.gen(function* () {
    const raw = yield* fetchPublicSkillText(runtime, {
      url: `${PUBLIC_SKILLS_API_URL}/git/trees/${treeSha}?recursive=1`,
      api: true,
      accept: "application/vnd.github+json",
      maxBytes: MAX_GITHUB_METADATA_BYTES,
      failureMessage: `Public skills revision ${revision.slice(0, 12)} could not be inspected.`,
      tooLargeMessage: `Public skills revision ${revision.slice(0, 12)} returned an oversized tree.`,
      errorFactory,
    });
    const response = yield* decodeGitHubTreeResponse(raw).pipe(
      Effect.mapError((cause) =>
        errorFactory(
          `Public skills revision ${revision.slice(0, 12)} returned malformed tree data.`,
          cause,
        ),
      ),
    );
    if (response.truncated) {
      return yield* Effect.fail(
        errorFactory(`Public skills revision ${revision.slice(0, 12)} returned a truncated tree.`),
      );
    }
    return response;
  });
}

function selectTreeEntries<E>(
  response: GitHubTree,
  revision: string,
  paths: ReadonlyArray<string>,
  errorFactory: (message: string, cause?: unknown) => E,
): Effect.Effect<ReadonlyArray<GitTreeEntry>, E> {
  const entries: GitTreeEntry[] = [];
  for (const entry of response.tree) {
    if (!paths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`))) continue;
    if (entry.type === "tree") continue;
    const object = entry.sha.toLowerCase();
    const size = entry.size ?? null;
    if (
      !/^[0-7]{6}$/u.test(entry.mode) ||
      !GIT_SHA_PATTERN.test(object) ||
      (size !== null && (!Number.isSafeInteger(size) || size < 0))
    ) {
      return Effect.fail(
        errorFactory(
          `Public skills revision ${revision.slice(0, 12)} returned malformed tree data.`,
        ),
      );
    }
    entries.push({
      mode: entry.mode,
      type: entry.type,
      object,
      size,
      path: entry.path,
    });
  }
  return Effect.succeed(entries);
}

function readRepositoryFile<E>(
  runtime: PublicSkillFetchRuntime,
  revision: string,
  filePath: string,
  expectedBytes: number,
  errorFactory: (message: string, cause?: unknown) => E,
): Effect.Effect<string, E> {
  return Effect.gen(function* () {
    const segments = filePath.split("/");
    if (
      segments.length === 0 ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      return yield* Effect.fail(errorFactory("A public skill file path was unsafe."));
    }
    const encodedPath = segments.map(encodeURIComponent).join("/");
    const content = yield* fetchPublicSkillText(runtime, {
      url: `${PUBLIC_SKILLS_RAW_URL}/${revision}/${encodedPath}`,
      api: false,
      accept: "text/plain",
      maxBytes: Math.min(MAX_SKILL_BYTES, expectedBytes + 1),
      failureMessage: "A public skill file could not be read.",
      tooLargeMessage: "A public skill file exceeded its tree metadata size.",
      errorFactory,
    });
    if (Buffer.byteLength(content) !== expectedBytes || content.includes("\0")) {
      return yield* Effect.fail(
        errorFactory("A public skill file did not match its Git tree metadata."),
      );
    }
    return content;
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

export interface PublicSkillRepositoryOptions {
  readonly catalogTtl?: Duration.Input;
  readonly rateLimitCooldown?: Duration.Input;
  readonly githubToken?: Redacted.Redacted<string> | null;
}

export class PublicSkillRepository extends Context.Service<
  PublicSkillRepository,
  {
    readonly discoverCatalog: Effect.Effect<
      ServerProviderSkillCatalog,
      ServerProviderSkillCatalogError
    >;
    readonly loadBundle: (input: {
      readonly id: string;
      readonly revision: string;
    }) => Effect.Effect<ServerProviderSkillBundle, ServerProviderSkillInstallError>;
  }
>()("t3/provider/publicSkillRepository") {}

export const make = Effect.fn("PublicSkillRepository.make")(function* (
  options: PublicSkillRepositoryOptions = {},
) {
  const httpClient = yield* HttpClient.HttpClient;
  const configuredToken =
    options.githubToken === undefined
      ? yield* Config.redacted(PUBLIC_SKILLS_GITHUB_TOKEN_ENV).pipe(
          Config.option,
          Effect.orElseSucceed(() => Option.none()),
        )
      : Option.fromNullishOr(options.githubToken);
  const runtime: PublicSkillFetchRuntime = {
    httpClient,
    githubToken: Option.getOrUndefined(configuredToken),
    cooldownUntil: yield* Ref.make(0),
    defaultCooldownMs: Duration.toMillis(
      options.rateLimitCooldown ?? PUBLIC_SKILLS_RATE_LIMIT_COOLDOWN,
    ),
  };
  const catalogTtl = options.catalogTtl ?? PUBLIC_SKILLS_CATALOG_TTL;

  const commitCache = yield* Cache.makeWith<string, ResolvedRevision, PublicSkillRepositoryFailure>(
    (revision) => resolveRevision(runtime, revision, repositoryError),
    {
      capacity: PUBLIC_SKILLS_COMMIT_CACHE_CAPACITY,
      timeToLive: (exit, revision) =>
        Exit.isSuccess(exit)
          ? GIT_SHA_PATTERN.test(revision)
            ? Duration.infinity
            : catalogTtl
          : Duration.zero,
    },
  );
  const treeCache = yield* Cache.makeWith<string, GitHubTree, PublicSkillRepositoryFailure>(
    (key) => {
      const [revision, tree] = JSON.parse(key) as [string, string];
      return loadTree(runtime, tree, revision, repositoryError);
    },
    {
      capacity: PUBLIC_SKILLS_TREE_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );
  const contentCache = yield* Cache.makeWith<string, string, PublicSkillRepositoryFailure>(
    (key) => {
      const [revision, filePath, expectedBytes] = JSON.parse(key) as [
        string,
        string,
        number,
        string,
      ];
      return readRepositoryFile(runtime, revision, filePath, expectedBytes, repositoryError);
    },
    {
      capacity: PUBLIC_SKILLS_CONTENT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );

  const resolveCachedRevision = Effect.fn("PublicSkillRepository.resolveCachedRevision")(function* (
    revision: string,
  ) {
    const resolved = yield* Cache.get(commitCache, revision);
    if (revision !== resolved.revision) {
      yield* Cache.set(commitCache, resolved.revision, resolved);
    }
    return resolved;
  });
  const loadCachedTree = (resolved: ResolvedRevision) =>
    Cache.get(treeCache, JSON.stringify([resolved.revision, resolved.tree]));
  const readCachedFile = (revision: string, entry: GitTreeEntry) => {
    if (entry.size === null) {
      return Effect.fail(repositoryError("A public skill file had no size metadata."));
    }
    return Cache.get(
      contentCache,
      JSON.stringify([revision, entry.path, entry.size, entry.object]),
    );
  };

  const buildCatalog = Effect.fn("PublicSkillRepository.buildCatalog")(function* () {
    const resolved = yield* resolveCachedRevision(PUBLIC_SKILLS_DEFAULT_BRANCH).pipe(
      Effect.mapError((error) => catalogError(error.message, error.detail)),
    );
    const treeResponse = yield* loadCachedTree(resolved).pipe(
      Effect.mapError((error) => catalogError(error.message, error.detail)),
    );
    const tree = yield* selectTreeEntries(
      treeResponse,
      resolved.revision,
      ["tritonai", "community"],
      catalogError,
    );
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
      const content = yield* readCachedFile(resolved.revision, entrypoint).pipe(
        Effect.mapError((error) => catalogError(error.message, error.detail)),
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
        revision: resolved.revision,
        sourceUrl: `${PUBLIC_SKILLS_REPOSITORY_URL}/tree/${resolved.revision}/${location.id}`,
      });
    }

    return {
      version: 1,
      repositoryUrl: PUBLIC_SKILLS_REPOSITORY_URL,
      revision: resolved.revision,
      fetchedAt: DateTime.formatIso(yield* DateTime.now),
      entries: entries.toSorted(
        (left, right) =>
          left.section.localeCompare(right.section) || left.title.localeCompare(right.title),
      ),
    } satisfies ServerProviderSkillCatalog;
  });

  const catalogCache = yield* Cache.makeWith<
    string,
    ServerProviderSkillCatalog,
    ServerProviderSkillCatalogError
  >(() => buildCatalog(), {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? catalogTtl : Duration.zero),
  });

  const discoverCatalog = Cache.get(catalogCache, PUBLIC_SKILLS_DEFAULT_BRANCH);
  const loadBundle: PublicSkillRepository["Service"]["loadBundle"] = Effect.fn(
    "PublicSkillRepository.loadBundle",
  )(function* (input) {
    const location = parsePublicSkillLocation(input.id);
    if (!location) {
      return yield* installError("The selected public skill path is invalid.");
    }
    const revision = input.revision.trim().toLowerCase();
    if (!GIT_SHA_PATTERN.test(revision)) {
      return yield* installError("The selected public skill revision is invalid.");
    }

    const resolved = yield* resolveCachedRevision(revision).pipe(
      Effect.mapError((error) => installError(error.message, error.detail)),
    );
    if (resolved.revision !== revision) {
      return yield* installError("The selected public skill revision did not resolve exactly.");
    }
    const treeResponse = yield* loadCachedTree(resolved).pipe(
      Effect.mapError((error) => installError(error.message, error.detail)),
    );
    const tree = yield* selectTreeEntries(treeResponse, revision, [location.id], installError);
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
        content: yield* readCachedFile(revision, entry).pipe(
          Effect.mapError((error) => installError(error.message, error.detail)),
        ),
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
  });

  return PublicSkillRepository.of({ discoverCatalog, loadBundle });
});

export const layer = Layer.effect(PublicSkillRepository, make());

const defaultRepository = Effect.runSync(Effect.cached(make()));

export const discoverPublicSkillCatalog = Effect.fn("discoverPublicSkillCatalog")(function* () {
  const repository = yield* defaultRepository;
  return yield* repository.discoverCatalog;
});

export const loadPublicSkillBundle = Effect.fn("loadPublicSkillBundle")(function* (input: {
  readonly id: string;
  readonly revision: string;
}) {
  const repository = yield* defaultRepository;
  return yield* repository.loadBundle(input);
});
