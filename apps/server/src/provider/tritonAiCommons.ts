// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalDate:off globalTimers:off
import {
  ServerTritonAiCommonsError,
  type ServerProviderSkillBundle,
  type ServerProviderSkillBundleFile,
  type ServerSubmitProviderSkillToTritonAiCommonsResult,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const COMMONS_OWNER = "dbalders";
const COMMONS_REPOSITORY = "UCSD-Skills-Library";
const MAX_SKILL_BYTES = 65_536;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_FILE_COUNT = 200;
const GITHUB_MISSING_MESSAGE =
  "GitHub could not find that item, or the signed-in user cannot access it.";

const REQUIRED_GITHUB_TOOLS = [
  "github.identity.get",
  "github.repositories.get",
  "github.repositories.fork",
  "github.branches.create",
  "github.contents.get",
  "github.contents.put",
  "github.pulls.list",
  "github.pulls.create",
] as const;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FRONTMATTER_KEY_PATTERN = /^[a-z][a-z0-9-]*$/u;
const FORBIDDEN_FRONTMATTER = new Set([
  "catalog",
  "tier",
  "publicationStatus",
  "category",
  "status",
]);
const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
]);
const SENSITIVE_FILE_SUFFIXES = new Set([".jks", ".key", ".keystore", ".p12", ".pfx", ".pem"]);
const LEAK_PATTERNS = [
  /AKIA[0-9A-Z]{16}/u,
  /https:\/\/[A-Za-z0-9._~!$&+,;=:%_-]+@github\.com/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /gh[pousr]_[A-Za-z0-9]{30,}/u,
  /xox[baprs]-[A-Za-z0-9-]{10,}/u,
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/u,
] as const;
const CREDENTIAL_ASSIGNMENT =
  /["']?\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|secret|token|password|passwd|pwd)(?:[_-][a-z0-9]+)*\b["']?\s*[:=]\s*(?:["'][^\n"']{12,}["']|[A-Za-z0-9_./+=:@-]{12,})/iu;
const PLACEHOLDER_MARKERS = [
  "...",
  "changeme",
  "dummy",
  "example",
  "fake",
  "placeholder",
  "redacted",
  "replace-me",
] as const;

export interface CommonsIntegrationRegistry {
  getAvailableToolDefinitionsSync(): ReadonlyArray<{ readonly name: string }>;
  invokeTool(
    name: string,
    input: unknown,
    context: { readonly signal: AbortSignal; readonly writeApproved?: boolean },
  ): Promise<unknown>;
}

export interface PreparedCommonsSubmission {
  readonly bundle: ServerProviderSkillBundle;
  readonly digest: string;
  readonly maintainer: string;
}

const isCommonsError = Schema.is(ServerTritonAiCommonsError);

type CommonsErrorCode = ServerTritonAiCommonsError["code"];

function commonsError(
  message: string,
  cause?: unknown,
  code: CommonsErrorCode = "invalid_skill",
): ServerTritonAiCommonsError {
  return new ServerTritonAiCommonsError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedString(value: unknown, field: string, maximum = 2_048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw commonsError(`GitHub returned invalid ${field} metadata.`);
  }
  return value;
}

function containsUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function isPlaceholderCredential(value: string): boolean {
  const normalized = value.trim().replace(/^["']|["']$/gu, "");
  const lower = normalized.toLowerCase();
  return (
    /^[A-Z][A-Z0-9_]{5,}$/u.test(normalized) ||
    normalized.startsWith("$") ||
    normalized.startsWith("{{") ||
    normalized.startsWith("<") ||
    lower.startsWith("env.") ||
    lower.startsWith("os.environ") ||
    lower.startsWith("process.env") ||
    lower.startsWith("secrets.") ||
    PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))
  );
}

function validatePublicBoundary(path: string, content: string): void {
  if (containsUnsafeControlCharacter(content)) {
    throw commonsError(
      `${path} contains control characters or non-text data. Commons submissions currently support text skill files only.`,
    );
  }
  if (LEAK_PATTERNS.some((pattern) => pattern.test(content))) {
    throw commonsError(
      `${path} appears to contain a secret or credential. Remove it before submitting.`,
    );
  }
  const assignment = CREDENTIAL_ASSIGNMENT.exec(content);
  if (assignment) {
    const value = assignment[0].slice(assignment[0].search(/[:=]/u) + 1);
    if (!isPlaceholderCredential(value)) {
      throw commonsError(
        `${path} appears to contain a hardcoded credential. Use a clear placeholder instead.`,
      );
    }
  }
}

function parseScalar(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw commonsError(`Frontmatter ${field} must not be empty.`);
  if (trimmed.startsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed) as unknown;
      if (typeof decoded !== "string" || decoded.trim().length === 0) throw new Error();
      return decoded.trim();
    } catch {
      throw commonsError(`Frontmatter ${field} must use a valid single-line string.`);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1) {
    return trimmed.slice(1, -1).replaceAll("''", "'").trim();
  }
  return trimmed;
}

function normalizeBundlePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/gu, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    parts.length === 0 ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw commonsError(`The local skill contains an unsafe path: ${relativePath}`);
  }
  const fileName = parts.at(-1)!.toLowerCase();
  const suffixIndex = fileName.lastIndexOf(".");
  const suffix = suffixIndex >= 0 ? fileName.slice(suffixIndex) : "";
  if (SENSITIVE_FILE_NAMES.has(fileName) || SENSITIVE_FILE_SUFFIXES.has(suffix)) {
    throw commonsError(
      `${parts.join("/")} is a sensitive file type and cannot be submitted publicly.`,
    );
  }
  return parts.join("/");
}

function prepareSkillMarkdown(input: {
  readonly markdown: string;
  readonly expectedName: string;
  readonly githubLogin: string;
}): { readonly markdown: string; readonly maintainer: string } {
  const markdown = input.markdown.replaceAll("\r\n", "\n");
  if (!markdown.startsWith("---\n")) {
    throw commonsError("The local SKILL.md must start with YAML frontmatter.");
  }
  const closing = markdown.indexOf("\n---\n", 4);
  if (closing < 0) throw commonsError("The local SKILL.md frontmatter is not closed.");
  const lines = markdown.slice(4, closing).split("\n");
  const fields = new Map<string, string>();
  for (const line of lines) {
    if (!line || /^\s/u.test(line)) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw commonsError("SKILL.md frontmatter must use one key and value per line.");
    }
    const key = line.slice(0, separator).trim();
    if (!FRONTMATTER_KEY_PATTERN.test(key)) {
      throw commonsError(`Frontmatter key '${key}' is not supported.`);
    }
    if (fields.has(key)) throw commonsError(`Frontmatter key '${key}' must not be repeated.`);
    const rawValue = line.slice(separator + 1);
    fields.set(
      key,
      key === "name" || key === "description" || key === "maintainer"
        ? parseScalar(rawValue, key)
        : rawValue.trim(),
    );
  }

  if (!NAME_PATTERN.test(input.expectedName) || input.expectedName.length > 64) {
    throw commonsError(
      "The local skill name must be 1-64 lowercase letters, numbers, and single hyphens before it can be submitted.",
    );
  }
  if (fields.get("name") !== input.expectedName) {
    throw commonsError("SKILL.md frontmatter name must exactly match the local skill folder name.");
  }
  if (!fields.get("description")) {
    throw commonsError("SKILL.md frontmatter must include a description before submission.");
  }
  const forbidden = [...fields.keys()].filter((key) => FORBIDDEN_FRONTMATTER.has(key));
  if (forbidden.length > 0) {
    throw commonsError(
      `Remove repository-only frontmatter before submitting: ${forbidden.toSorted().join(", ")}.`,
    );
  }
  if (!markdown.slice(closing + 5).trim()) {
    throw commonsError("SKILL.md must contain instructions after its frontmatter.");
  }

  const existingMaintainer = fields.get("maintainer")?.trim();
  const maintainer = existingMaintainer || `@${input.githubLogin}`;
  const preparedLines = existingMaintainer
    ? lines
    : [...lines, `maintainer: ${JSON.stringify(maintainer)}`];
  const prepared = `---\n${preparedLines.join("\n")}\n---\n${markdown.slice(closing + 5)}`;
  if (new TextEncoder().encode(prepared).byteLength > MAX_SKILL_BYTES) {
    throw commonsError("SKILL.md is larger than the 64 KiB TritonAI Commons limit.");
  }
  validatePublicBoundary("SKILL.md", prepared);
  return { markdown: prepared, maintainer };
}

function digestBundle(files: ReadonlyArray<ServerProviderSkillBundleFile>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files.toSorted((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path, "utf8").update("\0").update(file.content, "utf8").update("\0");
  }
  return hash.digest("hex");
}

export function prepareTritonAiCommonsSubmission(input: {
  readonly bundle: ServerProviderSkillBundle;
  readonly githubLogin: string;
}): PreparedCommonsSubmission {
  if (input.bundle.files.length === 0 || input.bundle.files.length > MAX_BUNDLE_FILE_COUNT) {
    throw commonsError("The local skill contains no files or too many files to submit.");
  }

  const seen = new Set<string>();
  const seenCaseInsensitive = new Set<string>();
  let totalBytes = 0;
  const normalizedFiles = input.bundle.files.map((file) => {
    const path = normalizeBundlePath(file.path);
    const lowerPath = path.toLowerCase();
    if (seen.has(path) || seenCaseInsensitive.has(lowerPath)) {
      throw commonsError(`The local skill contains a duplicate path: ${file.path}`);
    }
    seen.add(path);
    seenCaseInsensitive.add(lowerPath);
    totalBytes += Buffer.byteLength(file.content);
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw commonsError("The local skill is larger than the 2 MiB Commons submission limit.");
    }
    validatePublicBoundary(path, file.content);
    return { path, content: file.content };
  });

  const entrypoint = normalizedFiles.find((file) => file.path === "SKILL.md");
  if (!entrypoint) throw commonsError("The local skill does not contain SKILL.md at its root.");
  const prepared = prepareSkillMarkdown({
    markdown: entrypoint.content,
    expectedName: input.bundle.skillId,
    githubLogin: input.githubLogin,
  });
  const files = normalizedFiles
    .map((file) => (file.path === "SKILL.md" ? { ...file, content: prepared.markdown } : file))
    .toSorted((left, right) => {
      if (left.path === "SKILL.md") return -1;
      if (right.path === "SKILL.md") return 1;
      return left.path.localeCompare(right.path);
    });
  return {
    bundle: { version: 1, skillId: input.bundle.skillId, files },
    digest: digestBundle(files),
    maintainer: prepared.maintainer,
  };
}

function isGitHubMissing(error: unknown): boolean {
  return error instanceof Error && error.message === GITHUB_MISSING_MESSAGE;
}

function publicGitHubError(error: unknown): ServerTritonAiCommonsError {
  if (isCommonsError(error)) return error;
  if (error instanceof Error && /cancel(?:led|ed)|aborted/iu.test(error.message)) {
    return commonsError("TritonAI Commons submission was cancelled.", undefined, "cancelled");
  }
  if (
    error instanceof Error &&
    (error.name === "IntegrationProviderPublicError" || error.name === "IntegrationOperationError")
  ) {
    const setupRequired =
      ("code" in error &&
        ["not_found", "not_installed", "disabled", "not_connected", "capability_required"].includes(
          String(error.code),
        )) ||
      /reconnect GitHub|session expired|authorization|required access|not connected/iu.test(
        error.message,
      );
    return commonsError(
      setupRequired
        ? `${error.message} Open Settings > Plugins > GitHub to finish setup, then retry.`
        : error.message,
      error,
      setupRequired ? "github_setup_required" : "submission_failed",
    );
  }
  return commonsError(
    "TritonAI Commons could not submit this skill. No pull request was merged. Retry, or reconnect GitHub in Settings > Plugins.",
    error,
    "submission_failed",
  );
}

function ensureToolsAvailable(registry: CommonsIntegrationRegistry): void {
  const available = new Set(registry.getAvailableToolDefinitionsSync().map(({ name }) => name));
  const missing = REQUIRED_GITHUB_TOOLS.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw commonsError(
      "GitHub submission is unavailable. Open Settings > Plugins > GitHub, connect your account, then enable repository read/write and pull-request access.",
      undefined,
      "github_setup_required",
    );
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    throw signal.reason ?? new Error("TritonAI Commons submission was cancelled.");
  await new Promise<void>((resolve, reject) => {
    const finish = () => signal.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      finish();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      finish();
      reject(signal.reason ?? new Error("TritonAI Commons submission was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function invokeRead(
  registry: CommonsIntegrationRegistry,
  signal: AbortSignal,
  name: string,
  input: unknown,
): Promise<unknown> {
  return registry.invokeTool(name, input, { signal });
}

async function invokeWrite(
  registry: CommonsIntegrationRegistry,
  signal: AbortSignal,
  name: string,
  input: unknown,
): Promise<unknown> {
  return registry.invokeTool(name, input, { signal, writeApproved: true });
}

async function repositoryMetadata(
  registry: CommonsIntegrationRegistry,
  signal: AbortSignal,
  owner: string,
): Promise<Record<string, unknown>> {
  const result = await invokeRead(registry, signal, "github.repositories.get", {
    owner,
    repo: COMMONS_REPOSITORY,
  });
  if (!isRecord(result)) throw commonsError("GitHub returned invalid repository metadata.");
  return result;
}

async function waitForFork(
  registry: CommonsIntegrationRegistry,
  signal: AbortSignal,
  owner: string,
): Promise<Record<string, unknown>> {
  for (const wait of [0, 250, 500, 1_000, 2_000, 2_000, 2_000]) {
    if (wait > 0) await delay(wait, signal);
    try {
      return await repositoryMetadata(registry, signal, owner);
    } catch (error) {
      if (!isGitHubMissing(error)) throw error;
    }
  }
  throw commonsError(
    "GitHub is still preparing the Commons fork. Wait a moment, then submit again.",
  );
}

function verifyCommonsFork(repository: Record<string, unknown>): void {
  const parent = repository.parent;
  if (repository.fork !== true || !isRecord(parent)) {
    throw commonsError(
      `The connected account already has a repository named ${COMMONS_REPOSITORY}, but it is not a TritonAI Commons fork. Rename it on GitHub before submitting.`,
    );
  }
  const fullName = boundedString(parent.full_name, "fork parent", 256);
  if (fullName.toLowerCase() !== `${COMMONS_OWNER}/${COMMONS_REPOSITORY}`.toLowerCase()) {
    throw commonsError(
      `The connected account's ${COMMONS_REPOSITORY} fork points to a different repository.`,
    );
  }
}

async function assertPathMissing(
  registry: CommonsIntegrationRegistry,
  signal: AbortSignal,
  owner: string,
  path: string,
  ref: string,
): Promise<void> {
  try {
    await invokeRead(registry, signal, "github.contents.get", {
      owner,
      repo: COMMONS_REPOSITORY,
      path,
      ref,
    });
  } catch (error) {
    if (isGitHubMissing(error)) return;
    throw error;
  }
  throw commonsError(
    `A skill named '${path.split("/")[1]}' already exists in TritonAI Commons. Installed Commons skills cannot be submitted again.`,
    undefined,
    "already_exists",
  );
}

async function assertSkillIsUnpublished(input: {
  readonly registry: CommonsIntegrationRegistry;
  readonly signal: AbortSignal;
  readonly owner: string;
  readonly name: string;
  readonly ref: string;
}): Promise<void> {
  await assertPathMissing(
    input.registry,
    input.signal,
    input.owner,
    `community/${input.name}/SKILL.md`,
    input.ref,
  );
  await assertPathMissing(
    input.registry,
    input.signal,
    input.owner,
    `tritonai/${input.name}/SKILL.md`,
    input.ref,
  );
}

function pullRequestBody(input: {
  readonly digest: string;
  readonly fileCount: number;
  readonly maintainer: string;
}): string {
  return [
    "## TritonAI Commons submission",
    "",
    "- Source: An existing local skill in TritonAI Harness.",
    `- Maintainer: ${input.maintainer}`,
    `- Files submitted: ${input.fileCount}`,
    `- Public copy SHA-256: \`${input.digest}\``,
    "- Public-boundary attestation: Harness found no credential patterns, private keys, or unsafe paths in the submitted text files.",
    "",
    "This contribution is submitted to the Community collection for maintainer review. Campus approval, if appropriate, is a later maintainer decision.",
    "",
    "Harness opened this pull request as ready for review and will not merge it automatically.",
  ].join("\n");
}

async function readGitHubFile(input: {
  readonly registry: CommonsIntegrationRegistry;
  readonly signal: AbortSignal;
  readonly owner: string;
  readonly path: string;
  readonly ref: string;
}): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await invokeRead(input.registry, input.signal, "github.contents.get", {
      owner: input.owner,
      repo: COMMONS_REPOSITORY,
      path: input.path,
      ref: input.ref,
    });
    if (!isRecord(result)) throw commonsError("GitHub returned invalid file metadata.");
    return result;
  } catch (error) {
    if (isGitHubMissing(error)) return undefined;
    throw error;
  }
}

function decodeGitHubTextFile(file: Record<string, unknown>, path: string): string {
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    throw commonsError(`GitHub returned unreadable content for ${path}.`);
  }
  const compact = file.content.replaceAll(/\s/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    throw commonsError(`GitHub returned invalid content for ${path}.`);
  }
  return Buffer.from(compact, "base64").toString("utf8");
}

async function ensureSubmissionBranch(input: {
  readonly registry: CommonsIntegrationRegistry;
  readonly signal: AbortSignal;
  readonly owner: string;
  readonly branch: string;
  readonly fromRef: string;
}): Promise<void> {
  // README.md is an upstream-owned sentinel that exists on every supported Commons base.
  // A deterministic branch lets an interrupted authorization flow resume without creating
  // unbounded orphan branches.
  const existing = await readGitHubFile({
    registry: input.registry,
    signal: input.signal,
    owner: input.owner,
    path: "README.md",
    ref: input.branch,
  });
  if (existing) return;
  await invokeWrite(input.registry, input.signal, "github.branches.create", {
    owner: input.owner,
    repo: COMMONS_REPOSITORY,
    branch: input.branch,
    fromRef: input.fromRef,
  });
}

async function putSubmissionFile(input: {
  readonly registry: CommonsIntegrationRegistry;
  readonly signal: AbortSignal;
  readonly owner: string;
  readonly branch: string;
  readonly skillName: string;
  readonly file: ServerProviderSkillBundleFile;
}): Promise<void> {
  const path = `community/${input.skillName}/${input.file.path}`;
  const existing = await readGitHubFile({
    registry: input.registry,
    signal: input.signal,
    owner: input.owner,
    path,
    ref: input.branch,
  });
  if (existing) {
    if (decodeGitHubTextFile(existing, path) !== input.file.content) {
      throw commonsError(
        `The resumable Commons branch contains different content at ${path}. No files were overwritten.`,
        undefined,
        "submission_failed",
      );
    }
    return;
  }
  await invokeWrite(input.registry, input.signal, "github.contents.put", {
    owner: input.owner,
    repo: COMMONS_REPOSITORY,
    path,
    branch: input.branch,
    message: `feat(commons): add ${input.skillName}${input.file.path === "SKILL.md" ? "" : ` ${input.file.path}`}`,
    content: input.file.content,
  });
}

async function findExistingSubmissionPullRequest(input: {
  readonly registry: CommonsIntegrationRegistry;
  readonly signal: AbortSignal;
  readonly head: string;
  readonly base: string;
}): Promise<string | undefined> {
  const value = await invokeRead(input.registry, input.signal, "github.pulls.list", {
    owner: COMMONS_OWNER,
    repo: COMMONS_REPOSITORY,
    state: "all",
    head: input.head,
    base: input.base,
    limit: 10,
    page: 1,
  });
  if (!Array.isArray(value)) throw commonsError("GitHub returned invalid pull-request metadata.");
  const pulls = value.filter(isRecord);
  const pull =
    pulls.find((candidate) => candidate.state === "open") ??
    pulls.find((candidate) => candidate.state !== "closed");
  if (!pull) {
    if (pulls.some((candidate) => candidate.state === "closed")) {
      throw commonsError(
        "A pull request for this exact skill version was previously closed. Reopen it on GitHub before retrying; Harness did not create a duplicate review.",
        undefined,
        "submission_failed",
      );
    }
    return undefined;
  }
  if (pull.draft === true) {
    throw commonsError(
      "The resumable Commons pull request is unexpectedly a draft. Open it on GitHub and mark it ready for review before retrying.",
      undefined,
      "submission_failed",
    );
  }
  const reviewUrl = boundedString(pull.html_url, "pull-request URL");
  if (!reviewUrl.startsWith("https://github.com/")) {
    throw commonsError("GitHub returned an unsafe pull-request URL.");
  }
  return reviewUrl;
}

export async function submitProviderSkillToTritonAiCommons(input: {
  readonly bundle: ServerProviderSkillBundle;
  readonly registry: CommonsIntegrationRegistry;
  readonly signal: AbortSignal;
}): Promise<ServerSubmitProviderSkillToTritonAiCommonsResult> {
  try {
    ensureToolsAvailable(input.registry);
    const identityValue = await invokeRead(input.registry, input.signal, "github.identity.get", {});
    if (!isRecord(identityValue)) throw commonsError("GitHub returned invalid identity metadata.");
    const login = boundedString(identityValue.login, "identity login", 100);
    const prepared = prepareTritonAiCommonsSubmission({ bundle: input.bundle, githubLogin: login });
    const name = prepared.bundle.skillId;

    const upstream = await repositoryMetadata(input.registry, input.signal, COMMONS_OWNER);
    const base = boundedString(upstream.default_branch, "default branch", 255);
    await assertSkillIsUnpublished({
      registry: input.registry,
      signal: input.signal,
      owner: COMMONS_OWNER,
      name,
      ref: base,
    });

    let targetOwner = COMMONS_OWNER;
    if (login.toLowerCase() !== COMMONS_OWNER.toLowerCase()) {
      targetOwner = login;
      let fork: Record<string, unknown>;
      try {
        fork = await repositoryMetadata(input.registry, input.signal, login);
      } catch (error) {
        if (!isGitHubMissing(error)) throw error;
        await invokeWrite(input.registry, input.signal, "github.repositories.fork", {
          owner: COMMONS_OWNER,
          repo: COMMONS_REPOSITORY,
        });
        fork = await waitForFork(input.registry, input.signal, login);
      }
      verifyCommonsFork(fork);
      const forkBase = boundedString(fork.default_branch, "fork default branch", 255);
      await assertSkillIsUnpublished({
        registry: input.registry,
        signal: input.signal,
        owner: login,
        name,
        ref: forkBase,
      });
    }

    const branch = `tritonai-commons/${name}-${prepared.digest.slice(0, 16)}`;
    const target = await repositoryMetadata(input.registry, input.signal, targetOwner);
    const fromRef = boundedString(target.default_branch, "target default branch", 255);
    await ensureSubmissionBranch({
      registry: input.registry,
      signal: input.signal,
      owner: targetOwner,
      branch,
      fromRef,
    });
    for (const file of prepared.bundle.files) {
      await putSubmissionFile({
        registry: input.registry,
        signal: input.signal,
        owner: targetOwner,
        branch,
        skillName: name,
        file,
      });
    }
    const pullHead = `${login}:${branch}`;
    const existingReviewUrl = await findExistingSubmissionPullRequest({
      registry: input.registry,
      signal: input.signal,
      head: pullHead,
      base,
    });
    if (existingReviewUrl) {
      return {
        reviewUrl: existingReviewUrl,
        branch,
        path: `community/${name}/SKILL.md`,
        skillName: name,
      };
    }
    const pullValue = await invokeWrite(input.registry, input.signal, "github.pulls.create", {
      owner: COMMONS_OWNER,
      repo: COMMONS_REPOSITORY,
      title: `feat(commons): add ${name}`,
      body: pullRequestBody({
        digest: prepared.digest,
        fileCount: prepared.bundle.files.length,
        maintainer: prepared.maintainer,
      }),
      head: targetOwner === COMMONS_OWNER ? branch : pullHead,
      base,
      draft: false,
    });
    if (!isRecord(pullValue)) throw commonsError("GitHub returned invalid pull-request metadata.");
    const reviewUrl = boundedString(pullValue.html_url, "pull-request URL");
    if (!reviewUrl.startsWith("https://github.com/")) {
      throw commonsError("GitHub returned an unsafe pull-request URL.");
    }
    return {
      reviewUrl,
      branch,
      path: `community/${name}/SKILL.md`,
      skillName: name,
    };
  } catch (error) {
    throw publicGitHubError(error);
  }
}
