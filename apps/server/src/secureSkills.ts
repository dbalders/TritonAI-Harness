// @effect-diagnostics nodeBuiltinImport:off - SHA-256 verifies untrusted skill feed bytes.
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { managedConfig, updateSecureSkillsDiagnostics } from "./managedPolicy.ts";
import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import {
  loadManagedSkillManifest,
  managedSkillManifestBlocksMutation,
} from "./provider/managedSkillManifest.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { resolveTritonAiServiceApiKey } from "./tritonAiCredential.ts";

const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_BYTES = 512 * 1024;
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SAFE_DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]{1,256}$/u;

const SecureSkillFeed = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(SAFE_SKILL_NAME)),
      digest: Schema.String.check(Schema.isPattern(SAFE_DIGEST)),
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String.check(Schema.isPattern(SAFE_FILE_PATH)),
          content: Schema.String,
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    }),
  ).check(Schema.isMaxLength(32)),
});
export type SecureSkillFeed = typeof SecureSkillFeed.Type;

const ManagedSkillManifest = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("tritonai-secure"),
  skills: Schema.Array(Schema.String),
});

const decodeFeed = Schema.decodeUnknownEffect(SecureSkillFeed);
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeManagedSkillManifest = Schema.encodeEffect(Schema.fromJsonString(ManagedSkillManifest));

export class SecureSkillsSyncError extends Schema.TaggedErrorClass<SecureSkillsSyncError>()(
  "SecureSkillsSyncError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
const isSecureSkillsSyncError = Schema.is(SecureSkillsSyncError);

function syncError(message: string, cause?: unknown): SecureSkillsSyncError {
  return new SecureSkillsSyncError({ message, ...(cause === undefined ? {} : { cause }) });
}

export function secureSkillDigest(
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(file.content, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export const validateSecureSkillFeed = Effect.fn("validateSecureSkillFeed")(function* (
  input: unknown,
) {
  const feed = yield* decodeFeed(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) =>
      syncError("The secure-skills feed did not match schema version 1.", cause),
    ),
  );
  const names = new Set<string>();
  for (const skill of feed.skills) {
    if (names.has(skill.name))
      return yield* syncError("The secure-skills feed contains duplicate names.");
    names.add(skill.name);
    if (!skill.files.some((file) => file.path === "SKILL.md")) {
      return yield* syncError(`Managed skill '${skill.name}' is missing SKILL.md.`);
    }
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of skill.files) {
      if (paths.has(file.path))
        return yield* syncError(`Managed skill '${skill.name}' contains duplicate paths.`);
      paths.add(file.path);
      bytes += Buffer.byteLength(file.content);
    }
    if (bytes > MAX_SKILL_BYTES)
      return yield* syncError(`Managed skill '${skill.name}' is too large.`);
    if (secureSkillDigest(skill.files) !== skill.digest) {
      return yield* syncError(`Managed skill '${skill.name}' failed digest verification.`);
    }
  }
  return feed;
});

export const synchronizeSecureSkillsFeed = Effect.fn("synchronizeSecureSkillsFeed")(function* (
  feed: SecureSkillFeed,
  skillsDirectory: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(skillsDirectory, { recursive: true });
      const managed = yield* loadManagedSkillManifest(skillsDirectory);
      if (managedSkillManifestBlocksMutation(managed.status)) {
        return yield* syncError("The existing managed-skills manifest is not safe to update.");
      }
      const previousNames = new Set(managed.skillNames);
      for (const skill of feed.skills) {
        if (
          !previousNames.has(skill.name) &&
          (yield* fs.exists(path.join(skillsDirectory, skill.name)))
        ) {
          return yield* syncError(
            `Managed skill '${skill.name}' conflicts with a user-owned skill.`,
          );
        }
      }

      const staging = yield* fs.makeTempDirectoryScoped({
        directory: skillsDirectory,
        prefix: ".secure-skills-stage.",
      });
      const backup = yield* fs.makeTempDirectoryScoped({
        directory: skillsDirectory,
        prefix: ".secure-skills-backup.",
      });
      for (const skill of feed.skills) {
        for (const file of skill.files) {
          const destination = path.join(staging, skill.name, ...file.path.split("/"));
          yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
          yield* fs.writeFileString(destination, file.content, { mode: 0o600 });
        }
      }

      const installed: string[] = [];
      const backedUp: string[] = [];
      const nextNames = feed.skills.map((skill) => skill.name).toSorted();
      yield* Effect.gen(function* () {
        for (const name of previousNames) {
          const target = path.join(skillsDirectory, name);
          if (!(yield* fs.exists(target))) continue;
          if (
            yield* fs.readLink(target).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          ) {
            return yield* syncError(`Managed skill '${name}' is a symbolic link.`);
          }
          yield* fs.rename(target, path.join(backup, name));
          backedUp.push(name);
        }
        for (const name of nextNames) {
          yield* fs.rename(path.join(staging, name), path.join(skillsDirectory, name));
          installed.push(name);
        }
        const manifest = yield* encodeManagedSkillManifest({
          version: 1,
          kind: "tritonai-secure",
          skills: nextNames,
        });
        yield* writeFileStringAtomically({
          filePath: path.join(skillsDirectory, ".tritonai-managed-skills.json"),
          contents: `${manifest}\n`,
          mode: 0o600,
        });
      }).pipe(
        Effect.mapError((cause) =>
          isSecureSkillsSyncError(cause)
            ? cause
            : syncError("Managed skills could not be installed transactionally.", cause),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            for (const name of installed) {
              yield* fs
                .remove(path.join(skillsDirectory, name), { recursive: true, force: true })
                .pipe(Effect.ignore);
            }
            for (const name of backedUp) {
              yield* fs
                .rename(path.join(backup, name), path.join(skillsDirectory, name))
                .pipe(Effect.ignore);
            }
            return yield* error;
          }),
        ),
      );
      return { revision: feed.revision, skillNames: nextNames };
    }),
  );
});

type FetchLike = typeof fetch;

export const readSecureSkillsResponseBody = Effect.fn("readSecureSkillsResponseBody")(function* (
  response: Response,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const reader = response.body?.getReader();
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_FEED_BYTES) {
            await reader.cancel();
            throw syncError("The secure-skills feed is too large.");
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    catch: (cause) =>
      isSecureSkillsSyncError(cause)
        ? cause
        : syncError("The secure-skills response could not be read.", cause),
  });
});

export const pollSecureSkillsOnce = Effect.fn("pollSecureSkillsOnce")(function* (options?: {
  readonly fetch?: FetchLike;
  readonly apiKey?: string;
}) {
  const endpoint = managedConfig.secureSkills.endpoint;
  if (!endpoint) {
    updateSecureSkillsDiagnostics({
      secureSkillsStatus: "not-configured",
      secureSkillsMessage: "No secure-skills endpoint is configured in this Harness release.",
    });
    return;
  }
  const apiKey = options?.apiKey?.trim() || resolveTritonAiServiceApiKey(process.env);
  if (!apiKey) {
    updateSecureSkillsDiagnostics({
      secureSkillsStatus: "missing-credential",
      secureSkillsMessage:
        "Secure skills are configured, but the managed TritonAI credential is unavailable.",
    });
    return;
  }
  updateSecureSkillsDiagnostics({ secureSkillsStatus: "syncing", secureSkillsMessage: null });
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const settings = yield* ServerSettingsService;
  const effective = yield* settings.getSettings;
  const layout = yield* resolveCodexHomeLayout(effective.providers.codex);
  const response = yield* Effect.tryPromise({
    try: () =>
      (options?.fetch ?? globalThis.fetch)(endpoint, {
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      }),
    catch: (cause) => syncError("The secure-skills endpoint could not be reached.", cause),
  });
  if (!response.ok)
    return yield* syncError(`The secure-skills endpoint returned HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_FEED_BYTES)
    return yield* syncError("The secure-skills feed is too large.");
  const raw = yield* readSecureSkillsResponseBody(response);
  const json = yield* decodeUnknownJson(raw).pipe(
    Effect.mapError((cause) => syncError("The secure-skills response was not valid JSON.", cause)),
  );
  const feed = yield* validateSecureSkillFeed(json);
  const result = yield* synchronizeSecureSkillsFeed(feed, `${layout.sharedHomePath}/skills`);
  updateSecureSkillsDiagnostics({
    secureSkillsStatus: "current",
    secureSkillsRevision: result.revision,
    secureSkillsLastCheckedAt: checkedAt,
    secureSkillsMessage: `${result.skillNames.length} managed secure skills are current.`,
  });
});

export const pollingLayer = Effect.gen(function* () {
  const poll = pollSecureSkillsOnce().pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const failure = Cause.squash(cause);
        updateSecureSkillsDiagnostics({
          secureSkillsStatus: "error",
          secureSkillsLastCheckedAt: DateTime.formatIso(yield* DateTime.now),
          secureSkillsMessage:
            failure instanceof Error
              ? failure.message
              : `Secure-skills poll failed: ${String(failure)}`,
        });
      }),
    ),
  );
  yield* poll.pipe(
    Effect.repeat(
      Schedule.spaced(Duration.minutes(managedConfig.secureSkills.pollIntervalMinutes)),
    ),
    Effect.forkScoped,
  );
});
